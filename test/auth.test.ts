import { beforeAll, describe, expect, test } from "bun:test";
import { authorized } from "../src/auth";

const bytes = (data: ArrayBuffer | ArrayBufferView) => (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));

beforeAll(() => {
  // Bun has no timingSafeEqual on SubtleCrypto.
  crypto.subtle.timingSafeEqual ??= (a, b) => bytes(a).length === bytes(b).length && bytes(a).every((byte, i) => byte === bytes(b)[i]);
});

const check = (token: string | undefined, header: string) =>
  authorized(new Request("http://x", { headers: { authorization: header } }), { INTERNAL_TOKEN: token });

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
