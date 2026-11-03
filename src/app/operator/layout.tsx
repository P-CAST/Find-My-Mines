import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isOperator } from "~/lib/operator";
import { getOperatorSession } from "~/server/better-auth/operator";

export default async function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getOperatorSession(await headers());
  if (!session) redirect("/?returnTo=%2Foperator");
  if (!isOperator(session.user)) notFound();
  return children;
}
