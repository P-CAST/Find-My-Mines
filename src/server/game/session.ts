import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { TRPCError } from "@trpc/server";

const processState = globalThis as typeof globalThis & {
  findMyMinesSigningKey?: string;
  findMyMinesLoginAttempts?: Map<string, { count: number; until: number }>;
};
const signingKey = (processState.findMyMinesSigningKey ??=
  randomBytes(32).toString("hex"));
const attempts = (processState.findMyMinesLoginAttempts ??= new Map<
  string,
  { count: number; until: number }
>());
const SESSION_COOKIE = "mines-session";
const OPERATOR_COOKIE = "mines-operator";
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
  const operatorCookie = readCookie(headers, OPERATOR_COOKIE);
  const [expiry, operatorSignature] = operatorCookie?.split(".") ?? [];
  const secret = process.env.GAME_OPERATOR_PASSWORD;
  const operator = !!(
    secret &&
    expiry &&
    operatorSignature &&
    Number(expiry) > Date.now() &&
    equal(operatorSignature, sign(`${id}.${expiry}`, secret))
  );
  return { id, operator, secure };
}
export function operatorLogin(
  id: string,
  password: string,
  responseHeaders: Headers,
  secure: boolean,
) {
  const secret = process.env.GAME_OPERATOR_PASSWORD;
  if (!secret || secret.length < 16)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Set GAME_OPERATOR_PASSWORD to at least 16 characters in .env on the server.",
    });
  const now = Date.now();
  for (const [key, value] of attempts)
    if (value.until <= now) attempts.delete(key);
  // Global cap as well as per-session cap prevents fresh cookies bypassing the limit.
  for (const key of [id, "all"]) {
    const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (entry.count >= (key === "all" ? 30 : 5))
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many login attempts. Try again in a minute.",
      });
    entry.count++;
    attempts.set(key, entry);
  }
  if (!equal(sign(password), sign(secret)))
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Incorrect operator password.",
    });
  attempts.delete(id);
  const expiry = String(now + 8 * 60 * 60 * 1000);
  setCookie(
    responseHeaders,
    OPERATOR_COOKIE,
    `${expiry}.${sign(`${id}.${expiry}`, secret)}`,
    8 * 60 * 60,
    secure,
  );
}
export function operatorLogout(responseHeaders: Headers, secure: boolean) {
  setCookie(responseHeaders, OPERATOR_COOKIE, "", 0, secure);
}
