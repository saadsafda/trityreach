"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

/** Only same-site paths, so ?next= can't bounce the user to another site. */
function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not log in");
      // A full navigation, so the proxy sees the new cookie on the next page.
      window.location.assign(safeNext(searchParams.get("next")));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not log in");
      setSubmitting(false);
    }
  }

  const inputClass =
    "h-[50px] w-full rounded-xl border border-[#d8d6e2] bg-white px-4 text-[15px] font-semibold text-ink outline-none transition-shadow placeholder:font-normal placeholder:text-[#aaa8b6] focus:border-indigo focus:shadow-[0_0_0_4px_rgba(91,79,233,0.09)]";

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">Username</span>
        <input
          className={inputClass}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">Password</span>
        <span className="relative">
          <input
            className={`${inputClass} pr-[72px]`}
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            className="absolute inset-y-0 right-2 my-auto h-[34px] rounded-lg border-0 bg-transparent px-2.5 text-[11px] font-bold text-muted hover:text-indigo"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </span>
      </label>

      {error && (
        <p className="m-0 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-4 py-3 text-[12px] text-[#9e3043]" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !username.trim() || !password}
        className="mt-1 inline-flex h-[52px] items-center justify-center gap-2 rounded-xl border border-indigo bg-indigo px-8 text-[14px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark"
      >
        {submitting && <span className="size-4 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />}
        {submitting ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
