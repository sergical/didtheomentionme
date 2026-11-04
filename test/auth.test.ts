import { beforeAll, describe, expect, test } from "bun:test";
import { authorized } from "../src/auth";
import type { Env } from "../src/env";

beforeAll(() => {
  // Bun has no timingSafeEqual on SubtleCrypto.
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
  subtle.timingSafeEqual ??= (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
});

const check = (token: string | undefined, header: string) =>
  authorized(new Request("http://x", { headers: { authorization: header } }), { INTERNAL_TOKEN: token } as Env);

describe("authorized", () => {
  test("a missing secret never authenticates", async () => {
    expect(await check(undefined, "Bearer undefined")).toBe(false);
  });

  test("an empty secret never authenticates", async () => {
    expect(await check("", "Bearer ")).toBe(false);
  });

  test("the correct token passes", async () => {
    expect(await check("s3cret", "Bearer s3cret")).toBe(true);
  });

  test("a wrong token fails", async () => {
    expect(await check("s3cret", "Bearer other!")).toBe(false);
  });
});
