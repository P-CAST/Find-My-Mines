import { TRPCError } from "@trpc/server";

type OperatorAccount = {
  role?: string | null;
  banned?: boolean | null;
  banExpires?: Date | null;
};

export function isOperator(user: OperatorAccount | null | undefined) {
  return !!(
    user?.role?.split(",").includes("admin") &&
    (!user.banned ||
      (user.banExpires && user.banExpires.getTime() <= Date.now()))
  );
}

export function requireOperatorAccount<T extends { user: OperatorAccount }>(
  session: T | null,
): T {
  if (!session)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Account login required.",
    });
  if (!isOperator(session.user))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Administrator access required.",
    });
  return session;
}
