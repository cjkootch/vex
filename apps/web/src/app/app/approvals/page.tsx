import { ApprovalsList } from "@/components/approvals/approvals-list";

export const dynamic = "force-dynamic";

export default function ApprovalsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-8 flex flex-col gap-2 border-b border-line-soft pb-5">
        <div className="text-eyebrow text-text-muted">Now · Awaiting review</div>
        <h1 className="text-title text-text-primary">Approvals</h1>
        <p className="text-sm text-text-secondary">
          Review T2+ agent suggestions before they execute. T1 internal writes
          appear here too — agents drafted them, you decide whether they ship.
        </p>
      </header>
      <ApprovalsList />
    </main>
  );
}
