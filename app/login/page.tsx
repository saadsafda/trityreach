import type { Metadata } from "next";
import { Suspense } from "react";
import LoginForm from "@/components/login-form";

export const metadata: Metadata = {
  title: "Log in | TrityReach",
};

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <span className="grid size-[50px] rotate-45 place-items-center rounded-[14px] bg-indigo shadow-[0_8px_18px_rgba(91,79,233,0.25)]">
            <span className="size-[16px] rounded-sm border-[3px] border-white border-l-transparent border-b-transparent" />
          </span>
          <div>
            <h1 className="m-0 text-[28px] font-bold tracking-[-0.04em] text-ink">Welcome back</h1>
            <p className="m-0 mt-1.5 text-[13px] text-muted">Log in to AI Trity Reach Engine</p>
          </div>
        </div>
        <section className="rounded-2xl border border-line bg-white p-6 shadow-panel sm:p-8">
          <Suspense>
            <LoginForm />
          </Suspense>
        </section>
      </div>
    </main>
  );
}
