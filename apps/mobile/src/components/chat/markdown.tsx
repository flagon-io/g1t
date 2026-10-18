import { type Block, type Span, blocks } from "@g1t/contracts/chat-markdown";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Fragment, createContext, useContext, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { type RefContext, refContext, refRoute, routeFor } from "@/lib/links";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { fonts, radius, space, useColors } from "@/theme";

/**
 * A message's Markdown, as the site draws it (components/chat/text.tsx),
 * from the same parser (@g1t/contracts/chat-markdown): nothing in a
 * message is HTML, links go only to the web, mail or a page on g1t, and
 * `@mentions`, `#channels` and `#123` references stand out. A link to a
 * page the app has opens there; any other opens in the browser.
 *
 * `#123` is read in `refs`, where the text was written: a repository for a
 * pull request's, the workspace for Chat's and a work item's. g1t says
 * what it names when it is tapped (app/ref.tsx).
 */
export function Markdown({ text, muted, refs }: { text: string; muted?: boolean; refs?: RefContext }) {
  const parsed = useMemo(() => blocks(text), [text]);
  const body = (
    <View style={{ gap: space.xs }}>
      {parsed.map((block, index) => (
        <BlockView key={index} block={block} muted={muted} />
      ))}
    </View>
  );
  return refs ? <RefsHere.Provider value={refs}>{body}</RefsHere.Provider> : body;
}

/** Where `#123` in the text being drawn is read; the workspace you are in when nothing says. */
const RefsHere = createContext<RefContext | null>(null);

function useOpen() {
  const { server, workspace } = useSignedIn();
  return (href: string) => {
    const path = href.startsWith(server.site) ? href.slice(server.site.length) || "/" : href.startsWith("/") ? href : null;
    const route = path ? routeFor(path) : null;
    if (route) return router.push(route as never);
    void WebBrowser.openBrowserAsync(path ? siteUrl(server, path) : href);
    void workspace;
  };
}

function BlockView({ block, muted }: { block: Block; muted?: boolean }) {
  const colors = useColors();
  const base = { color: muted ? colors.muted : colors.fg, fontSize: 15, lineHeight: 21 };
  switch (block.t) {
    case "p":
      return (
        <Text style={base} selectable>
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 ? "\n" : null}
              <Spans spans={line} />
            </Fragment>
          ))}
        </Text>
      );
    case "heading":
      return (
        <Text style={[base, { fontWeight: "700", fontSize: block.level <= 2 ? 17 : 15 }]}>
          <Spans spans={block.c} />
        </Text>
      );
    case "code":
      return (
        <ScrollView horizontal style={[styles.codeBlock, { backgroundColor: colors.raised, borderColor: colors.line }]}>
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 13, lineHeight: 19, color: colors.fgSoft }}>
            {block.v}
          </Text>
        </ScrollView>
      );
    case "list":
      return (
        <View style={{ gap: 2 }}>
          {block.items.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", gap: space.sm }}>
              <Text style={[base, { color: colors.muted, minWidth: 16 }]}>{block.ordered ? `${block.start + index}.` : "•"}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                {item.map((inner, at) => (
                  <BlockView key={at} block={inner} muted={muted} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case "quote":
      return (
        <View style={[styles.quote, { borderLeftColor: colors.lineStrong }]}>
          {block.c.map((inner, index) => (
            <BlockView key={index} block={inner} muted />
          ))}
        </View>
      );
    case "hr":
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginVertical: space.xs }} />;
    case "table":
      return (
        <ScrollView horizontal>
          <View style={[styles.table, { borderColor: colors.line }]}>
            {[block.head, ...block.rows].map((row, rowIndex) => (
              <View key={rowIndex} style={{ flexDirection: "row", backgroundColor: rowIndex === 0 ? colors.raised : "transparent" }}>
                {row.map((cell, cellIndex) => (
                  <Text
                    key={cellIndex}
                    style={[base, styles.cell, { borderColor: colors.line, fontWeight: rowIndex === 0 ? "600" : "400", textAlign: block.align[cellIndex] ?? "left" }]}
                  >
                    <Spans spans={cell} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
}

function Spans({ spans }: { spans: Span[] }) {
  const colors = useColors();
  const open = useOpen();
  const { workspace } = useSignedIn();
  const given = useContext(RefsHere);
  const here = given ?? (workspace ? { workspace: workspace.slug } : null);
  return (
    <>
      {spans.map((span, index) => {
        switch (span.t) {
          case "text":
            return <Fragment key={index}>{span.v}</Fragment>;
          case "code":
            return (
              <Text key={index} style={{ fontFamily: fonts.mono, fontSize: 13, backgroundColor: colors.raised, color: colors.fgSoft }}>
                {` ${span.v} `}
              </Text>
            );
          case "strong":
            return (
              <Text key={index} style={{ fontWeight: "700" }}>
                <Spans spans={span.c} />
              </Text>
            );
          case "em":
            return (
              <Text key={index} style={{ fontStyle: "italic" }}>
                <Spans spans={span.c} />
              </Text>
            );
          case "del":
            return (
              <Text key={index} style={{ textDecorationLine: "line-through" }}>
                <Spans spans={span.c} />
              </Text>
            );
          case "link":
            return (
              <Text key={index} style={{ color: colors.accent, textDecorationLine: "underline" }} onPress={() => open(span.href)}>
                <Spans spans={span.c} />
              </Text>
            );
          case "mention":
            return (
              <Text key={index} style={{ color: colors.accent, backgroundColor: colors.accentLow, fontWeight: "600" }}>
                @{span.name}
              </Text>
            );
          case "channel":
            return (
              <Text key={index} style={{ color: colors.accent, fontWeight: "600" }} onPress={() => workspace && open(`/${workspace.slug}/-/chat/${span.name}`)}>
                #{span.name}
              </Text>
            );
          case "ref":
            return (
              <Text key={index} style={{ color: colors.accent }} onPress={() => here && router.push(refRoute(refContext(span.repo, here), span.number) as never)}>
                {span.repo ? `${span.repo}#${span.number}` : `#${span.number}`}
              </Text>
            );
        }
      })}
    </>
  );
}

const styles = StyleSheet.create({
  codeBlock: { borderWidth: 1, borderRadius: radius.sm, padding: space.sm },
  quote: { borderLeftWidth: 3, paddingLeft: space.sm, gap: space.xs },
  table: { borderWidth: 1, borderRadius: radius.sm },
  cell: { paddingHorizontal: space.sm, paddingVertical: 4, minWidth: 80, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
});
