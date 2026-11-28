import { describe, expect, test } from "bun:test";
import { groupPosts, parseReaderLines } from "../src/pipeline";

describe("groupPosts", () => {
  const line =(handle: string, text: string, displayName = "Name") => ({ handle, displayName, text });

  test("makes one group per post, with its own times", () => {
    const groups = groupPosts([
      { second: 100, line: line("@Theo", "Anthropic has no small model") },
      { second: 105, line: line("@theo", "Anthropic has no small model anymore, right") },
      { second: 110, line: line("@Theo", "Anthropic has no small model anymore, right") },
      { second: 105, line: line("@theo", "something completely different here") },
    ]);

    expect(groups).toEqual([
      {
        handle: "@Theo",
        displayName: "Name",
        text: "Anthropic has no small model anymore, right",
        slices: ["Anthropic has no small model anymore, right"],
        firstSeen: 100,
        lastSeen: 110,
        frameSecond: 100,
      },
      {
        handle: "@theo",
        displayName: "Name",
        text: "something completely different here",
        slices: ["something completely different here"],
        firstSeen: 105,
        lastSeen: 105,
        frameSecond: 105,
      },
    ]);
  });

  test("keeps each slice of one scrolled post, which share only a run of words", () => {
    const top = "We are doubling all usage limits for all tiers today and we will keep shipping better models over time";
    const bottom = "keep shipping better models over time so your effective usage grows and nothing else changes for anyone at all";

    const [group, ...rest] = groupPosts([
      { second: 0, line: line("@tibo", top) },
      { second: 5, line: line("@tibo", bottom) },
    ]);

    expect(rest).toEqual([]);
    expect(group.slices).toEqual([bottom, top]);
    expect(group.lastSeen).toBe(5);
  });

  test("the top of a post with few words on screen joins the rest of the post", () => {
    const groups = groupPosts([
      { second: 0, line: line("@dedene", "\"Coding is solved.\"") },
      { second: 5, line: line("@dedene", "\"Coding is solved.\" But we still cannot hot reload the agent") },
    ]);

    expect(groups).toHaveLength(1);
  });

  test("a frame that cut a post off mid-word joins the rest of the post", () => {
    const groups = groupPosts([
      { second: 0, line: line("@peterpme", "poteto's cursor profi") },
      { second: 5, line: line("@peterpme", "poteto's cursor profile is public. She's used 1.5T tokens") },
    ]);

    expect(groups).toHaveLength(1);
  });

  test("a short post does not join an author's other post by a shared word", () => {
    const groups = groupPosts([
      { second: 0, line: line("@tibo", "Yes") },
      { second: 5, line: line("@tibo", "We are doubling all limits, yes") },
    ]);

    expect(groups.map((g) => g.text)).toEqual(["Yes", "We are doubling all limits, yes"]);
  });

  test("merges misread spellings of one handle under the most common one", () => {
    const groups = groupPosts([
      { second: 509, line: line("@lydhahallie", "a") },
      { second: 514, line: line("@lydiahallie", "a") },
      { second: 519, line: line("@lydiahallie", "a") },
      { second: 1108, line: line("@gautamgoel978", "b") },
      { second: 1113, line: line("@gautamgoel978", "b") },
      { second: 1128, line: line("@gautamgoel", "b") },
    ]);

    expect(groups.map((g) => [g.handle, g.firstSeen, g.lastSeen])).toEqual([
      ["@lydiahallie", 509, 519],
      ["@gautamgoel978", 1108, 1128],
    ]);
  });

  test("keeps different handles apart even with the same text", () => {
    const groups = groupPosts([
      { second: 1, line: line("@a", "same text here") },
      { second: 2, line: line("@b", "same text here") },
    ]);

    expect(groups.map((g) => g.handle)).toEqual(["@a", "@b"]);
  });

  test("keeps a near handle with another display name apart", () => {
    const text = "We are releasing a new version today";

    const groups = groupPosts([
      { second: 0, line: { handle: "@opencode", displayName: "OpenCode", text } },
      { second: 5, line: { handle: "@odincode", displayName: "Mikey", text } },
    ]);

    expect(groups.map((g) => g.handle)).toEqual(["@opencode", "@odincode"]);
  });

  test("merges a near handle with the same display name, and one handle under a misread name", () => {
    const text = "We are releasing a new version today";

    const groups = groupPosts([
      { second: 0, line: { handle: "@thsottiaux", displayName: "Tibo", text } },
      { second: 5, line: { handle: "@thsoittiaux", displayName: "Tibo", text } },
      { second: 10, line: { handle: "@thsottiaux", displayName: "Tib0", text } },
    ]);

    expect(groups.map((g) => [g.handle, g.lastSeen])).toEqual([["@thsottiaux", 10]]);
  });

  test("joins a misread handle to the group with the same post text", () => {
    const post = "She strives to be a power user of every tool she touches and writes about it";

    const groups = groupPosts([
      { second: 1920, line: line("@poteto", post) },
      { second: 1925, line: line("@lauren", `${post} every week`, "Lauren") },
      { second: 1930, line: line("@poteto", post) },
    ]);

    expect(groups.map((g) => [g.handle, g.firstSeen, g.lastSeen])).toEqual([["@poteto", 1920, 1930]]);
  });

  test("a short post does not join a longer post with the same words", () => {
    const groups = groupPosts([
      { second: 0, line: line("@alice", "yes") },
      { second: 5, line: line("@bob", "yes this completely different post concerns database backups") },
    ]);

    expect(groups.map((g) => g.handle)).toEqual(["@alice", "@bob"]);
  });

  test("a placeholder handle joins by text, or keeps its own group", () => {
    const post = "Placeholder handles come from the reader copying its output format";
    const [placeholder] = parseReaderLines(`@handle | display name | ${post}`);
    expect(placeholder).toEqual({ handle: "@unknown", displayName: "", text: post });

    const groups = groupPosts([
      { second: 1, line: placeholder },
      { second: 6, line: line("@theo", post) },
      { second: 11, line: { ...placeholder, text: "a different post that nobody can read the handle of" } },
    ]);

    expect(groups.map((g) => [g.handle, g.displayName, g.lastSeen])).toEqual([["@theo", "Name", 6], ["@unknown", "", 11]]);
  });

  test("short unknown posts join by text instead of one group per frame", () => {
    const unknown = (text: string) => ({ handle: "@unknown", displayName: "", text });

    const groups = groupPosts([
      { second: 1, line: unknown("this is great") },
      { second: 6, line: unknown("this is great") },
      { second: 11, line: unknown("a different short post") },
    ]);

    expect(groups.map((g) => [g.firstSeen, g.lastSeen])).toEqual([[1, 6], [11, 11]]);
  });

  test("short unknown posts stay apart when the words or the display name differ", () => {
    const unknown = (displayName: string, text: string) => ({ handle: "@unknown", displayName, text });

    const groups = groupPosts([
      { second: 1, line: unknown("Alice", "this is great") },
      { second: 6, line: unknown("Alice", "this is not great") },
      { second: 11, line: unknown("Bob", "this is great") },
    ]);

    expect(groups.map((g) => [g.displayName, g.text])).toEqual([["Alice", "this is great"], ["Alice", "this is not great"], ["Bob", "this is great"]]);
  });

  test("orders by second regardless of input order", () => {
    const [group] = groupPosts([
      { second: 20, line: line("@a", "same text here") },
      { second: 10, line: line("@a", "same text here") },
    ]);

    expect(group.firstSeen).toBe(10);
    expect(group.frameSecond).toBe(10);
    expect(group.lastSeen).toBe(20);
  });
});
