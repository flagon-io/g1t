import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRIMARY_WINDOW_SECONDS,
  bookmarkCookie,
  coveredMs,
  mayWrite,
  metricName,
  readBookmarks,
  rpcMethodOf,
  serverTiming,
  serviceDuration,
  databaseTime,
  sessionFor,
  writeBookmarks,
} from "./perf.ts";

const BOOKMARK = "0000002c-00000004-00004f95-c7f4a9b2e8d1f0c3b6a5d4e3f2a1b0c9";

test("bookmarks survive the cookie", () => {
  const value = writeBookmarks({ at: 1_800_000_000, services: { work: BOOKMARK, repos: BOOKMARK } });
  assert.equal(value, `at:1800000000~repos:${BOOKMARK}~work:${BOOKMARK}`);
  assert.deepEqual(readBookmarks(`g1t_session=abc; g1t_d1=${value}; other=1`), {
    at: 1_800_000_000,
    services: { repos: BOOKMARK, work: BOOKMARK },
  });
});

test("a malformed or foreign cookie entry is dropped", () => {
  assert.deepEqual(readBookmarks(null), { at: null, services: {} });
  assert.deepEqual(readBookmarks("g1t_d1=at:soon~work:bad bookmark~actions:abc~repos:" + BOOKMARK), {
    at: null,
    services: { repos: BOOKMARK },
  });
  // Only a service that reads with sessions is kept.
  assert.equal(writeBookmarks({ at: null, services: { actions: BOOKMARK } }), "");
});

test("the cookie is HttpOnly, short-lived and Secure over HTTPS", () => {
  const cookie = bookmarkCookie({ at: 1, services: {} }, true);
  assert.match(cookie, /^g1t_d1=at:1; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/);
  assert.doesNotMatch(bookmarkCookie({ at: 1, services: {} }, false), /Secure/);
});

test("what each call asks for", () => {
  const now = 1_800_000_000;
  const none = { at: null, services: {} };
  // A service without sessions is left alone: its primary, as before.
  assert.equal(sessionFor("actions", none, false, now), null);
  // A form post reads the primary everywhere.
  assert.equal(sessionFor("work", { at: null, services: { work: BOOKMARK } }, true, now), "first-primary");
  // A page with no recent write reads the nearest copy.
  assert.equal(sessionFor("work", none, false, now), "first-unconstrained");
  // Just after a write, every service reads its primary, bookmark or not.
  const justWrote = { at: now - 5, services: { work: BOOKMARK } };
  assert.equal(sessionFor("work", justWrote, false, now), "first-primary");
  assert.equal(sessionFor("repos", justWrote, false, now), "first-primary");
  // Later, the bookmark keeps the read at least as new as the write.
  const later = { at: now - PRIMARY_WINDOW_SECONDS, services: { work: BOOKMARK } };
  assert.equal(sessionFor("work", later, false, now), BOOKMARK);
  assert.equal(sessionFor("repos", later, false, now), "first-unconstrained");
});

test("only known reads are taken not to write", () => {
  for (const method of ["get_pull", "list_pulls", "counts", "user_for_session", "explore", "usage", "get", "list", "queue", "pulls_for_repos"]) {
    assert.equal(mayWrite(method), false, method);
  }
  for (const method of ["merge_pull", "verify_email", "github_finish", "sign_in", "something_new"]) {
    assert.equal(mayWrite(method), true, method);
  }
  assert.equal(rpcMethodOf("https://service/rpc/get_pull"), "get_pull");
  assert.equal(rpcMethodOf("https://service/other"), "");
});

test("timings", () => {
  assert.equal(serviceDuration('svc;dur=12;desc="session"'), 12);
  assert.equal(serviceDuration("repo;dur=3, svc;dur=7.5"), 7.5);
  assert.equal(serviceDuration(null), null);
  assert.deepEqual(databaseTime('svc;dur=40;desc="session", db;dur=22;desc="2 round trips, 21 statements", rpc;dur=18;desc="1 calls"'), { ms: 22, trips: 2 });
  assert.equal(databaseTime('svc;dur=40;desc="session"'), null);
  // Overlapping calls are counted once.
  assert.equal(coveredMs([[0, 100], [50, 120], [200, 210]]), 130);
  assert.equal(coveredMs([]), 0);
  assert.equal(metricName("routes/repo/pull"), "repo.pull");
  const header = serverTiming({
    totalMs: 180,
    loaders: [{ id: "routes/repo/pull", ms: 150, kind: "loader" }],
    rpcMs: 140,
    services: {
      work: { calls: 3, wallMs: 120, serviceMs: 90, dbMs: 40, dbTrips: 3 },
      repos: { calls: 1, wallMs: 30, serviceMs: 0 },
    },
    sessions: "work=unconstrained",
  });
  assert.equal(
    header,
    'total;dur=180;desc="web to first byte", loader.repo.pull;dur=150, rpc;dur=140;desc="4 service calls, overlap counted once", ' +
      'work;dur=120;desc="3 calls, 90ms inside, db 40ms in 3 round trips", repos;dur=30;desc="1 call", d1;desc="work=unconstrained"',
  );
});
