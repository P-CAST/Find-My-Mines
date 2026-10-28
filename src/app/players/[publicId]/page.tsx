import { HistoryView } from "~/app/_components/game/history-view";
export default async function PublicHistoryPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  return <HistoryView publicId={publicId} />;
}
