import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

const processState = globalThis as typeof globalThis & {
  findMyMinesSigningKey?: string;
};
const signingKey = (processState.findMyMinesSigningKey ??=
  randomBytes(32).toString("hex"));
const SESSION_COOKIE = "mines-session";
const GUEST_NAME_COOKIE = "mines-guest-name";
export const nicknameInput = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .refine((value) => !/[\p{C}]/u.test(value), "Use 1–24 visible characters.");
function sign(value: string, key = signingKey) {
  return createHmac("sha256", key).update(value).digest("hex");
}
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function readCookie(headers: Headers, name: string) {
  return headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function setCookie(
  headers: Headers,
  name: string,
  value: string,
  age: number,
  secure: boolean,
) {
  headers.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`,
  );
}
export function gameSession(
  headers: Headers,
  responseHeaders: Headers,
  secure = false,
) {
  const cookie = readCookie(headers, SESSION_COOKIE);
  const [candidate, signature] = cookie?.split(".") ?? [];
  let id: string;
  if (
    candidate &&
    signature &&
    /^[a-f0-9-]{36}$/.test(candidate) &&
    equal(signature, sign(candidate))
  )
    id = candidate;
  else {
    id = randomUUID();
    setCookie(
      responseHeaders,
      SESSION_COOKIE,
      `${id}.${sign(id)}`,
      86400,
      secure,
    );
  }
  let guestName: string | null = null;
  const nameCookie = readCookie(headers, GUEST_NAME_COOKIE);
  const [payload, nameSignature] = nameCookie?.split(".") ?? [];
  if (
    payload &&
    nameSignature &&
    equal(nameSignature, sign(`${id}.${payload}`))
  ) {
    try {
      const parsed = z
        .object({ name: nicknameInput, expires: z.number() })
        .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (parsed.expires > Date.now()) guestName = parsed.name;
    } catch {
      // Invalid name cookies never supply a display name.
    }
  }
  return { id, secure, guestName };
}
/** The name is a display label; authorization remains the signed session ID. */
export function setGuestName(
  session: ReturnType<typeof gameSession>,
  name: string,
  responseHeaders: Headers,
) {
  const nickname = nicknameInput.parse(name);
  if (session.guestName) {
    if (session.guestName !== nickname)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Your guest name is fixed for this session.",
      });
    return session.guestName;
  }
  const payload = Buffer.from(
    JSON.stringify({ name: nickname, expires: Date.now() + 86400_000 }),
  ).toString("base64url");
  setCookie(
    responseHeaders,
    GUEST_NAME_COOKIE,
    `${payload}.${sign(`${session.id}.${payload}`)}`,
    86400,
    session.secure,
  );
  return nickname;
}

export function playerName(
  accountName: string | null | undefined,
  guestName: string | null,
) {
  if (accountName != null)
    return nicknameInput.parse(
      accountName
        .slice(0, 24)
        .replace(/[\p{C}]/gu, "")
        .trim(),
    );
  if (!guestName)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Choose your guest name on the homepage first.",
    });
  return nicknameInput.parse(guestName);
}
