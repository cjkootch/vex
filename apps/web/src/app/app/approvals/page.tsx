import { ApprovalsList } from "@/components/approvals/approvals-list";

export const dynamic = "force-dynamic";

export default function ApprovalsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-white">Approvals</h1>
        <p className="text-sm text-white/50">
          Review T2+ agent suggestions before they execute. T1 internal writes
          appear here too — agents drafted them, you decide whether they ship.
        </p>
      </header>
      <ApprovalsList />
    </main>
  );
}
