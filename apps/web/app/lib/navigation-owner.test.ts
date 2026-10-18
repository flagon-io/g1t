import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryRouter, redirect } from "react-router";
import { pageOwnsNavigation, pendingNavigationOwns, sidebarLocation } from "./navigation-owner.ts";

test("an old page loses navigation ownership as soon as a newer click starts", async () => {
  let finish!: (value: Response) => void;
  const slow = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const router = createMemoryRouter(
    [{ path: "/home" }, { path: "/artifacts", loader: () => slow }, { path: "/code", loader: () => "latest" }, { path: "/old-redirect" }],
    { initialEntries: ["/home"] },
  );
  try {
    const homeKey = router.state.location.key;
    assert.equal(pageOwnsNavigation(router.state, homeKey), true);
    const first = router.navigate("/artifacts");
    const firstKey = router.state.navigation.location?.key;
    assert.equal(sidebarLocation(router.state).pathname, "/artifacts", "sidebar follows the pending click immediately");
    assert.equal(pageOwnsNavigation(router.state, homeKey), false, "old effects must not override a pending click");
    assert.equal(pendingNavigationOwns(router.state.navigation, firstKey), true);
    await router.navigate("/code");
    assert.equal(sidebarLocation(router.state).pathname, "/code");
    finish(redirect("/old-redirect"));
    await first;
    assert.equal(router.state.location.pathname, "/code");
    assert.equal(sidebarLocation(router.state).pathname, "/code", "late redirects cannot move the sidebar back");
    assert.equal(pageOwnsNavigation(router.state, homeKey), false);
    assert.equal(pendingNavigationOwns(router.state.navigation, firstKey), false, "an old recovery timer must not fire");
    await router.navigate("/home");
    assert.equal(pageOwnsNavigation(router.state, homeKey), false, "returning to the same URL is a new visit");
  } finally {
    router.dispose();
  }
});

test("repeated clicks to the same path have different recovery owners", () => {
  assert.equal(pendingNavigationOwns({ state: "loading", location: { key: "second-click" } }, "first-click"), false);
  assert.equal(pendingNavigationOwns({ state: "submitting", location: { key: "first-click" } }, "first-click"), false);
});

for (const [firstPath, latestPath] of [
  ["/artifacts/one", "/artifacts/two"],
  ["/artifacts/one", "/code"],
]) {
  test(`latest sidebar destination wins: ${firstPath} then ${latestPath}`, async () => {
    let finishFirst!: (value: string) => void;
    let finishLatest!: (value: string) => void;
    const firstLoad = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const latestLoad = new Promise<string>((resolve) => {
      finishLatest = resolve;
    });
    const router = createMemoryRouter([{ path: "/home" }, { path: firstPath, loader: () => firstLoad }, { path: latestPath, loader: () => latestLoad }], {
      initialEntries: ["/home"],
    });
    const seen: string[] = [];
    const unsubscribe = router.subscribe((state) => seen.push(sidebarLocation(state).pathname));
    try {
      const first = router.navigate(firstPath);
      const latest = router.navigate(latestPath);
      assert.equal(sidebarLocation(router.state).pathname, latestPath);
      finishFirst("stale");
      await first;
      assert.equal(router.state.location.pathname, "/home", "stale page must not commit while the latest page loads");
      assert.equal(sidebarLocation(router.state).pathname, latestPath);
      finishLatest("latest");
      await latest;
      assert.equal(router.state.location.pathname, latestPath);
      assert.deepEqual(seen, [firstPath, latestPath, latestPath], "subscribers never see the stale destination again");
    } finally {
      unsubscribe();
      router.dispose();
    }
  });
}
