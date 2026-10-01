'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const supabase = createClient();

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleResetRequest = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!email.trim()) {
      setErrorMsg('Please enter your email address.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${origin}/auth/callback?next=/reset-password`,
      });

      if (error) {
        setErrorMsg(error.message || 'Unable to send reset instructions. Please try again.');
        return;
      }

      setIsSubmitted(true);
      setCooldown(60);
    } catch (err: any) {
      console.error('Reset password request error:', err);
      setErrorMsg('An unexpected error occurred. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0c10] bg-dot-pattern flex items-center justify-center p-4 relative overflow-hidden select-none">
      {/* Ambient background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[550px] h-[350px] bg-[#fbcfe8]/10 blur-[130px] rounded-full pointer-events-none" />

      <div className="w-full max-w-md bg-[#13151b]/90 backdrop-blur-2xl border border-[#48454d]/35 rounded-3xl p-8 shadow-[0_25px_60px_rgba(0,0,0,0.8)] relative z-10 space-y-6 animate-in fade-in zoom-in-95 duration-200">
        {/* Header Branding */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[#241c2c] border border-[#fbcfe8]/40 text-[#fbcfe8] shadow-lg shadow-[#fbcfe8]/10 mb-1">
            <span className="material-symbols-outlined text-[26px]">
              {isSubmitted ? 'mark_email_read' : 'lock_reset'}
            </span>
          </div>
          <h1 className="text-2xl font-heading font-bold text-white tracking-tight">
            {isSubmitted ? 'Check Your Email' : 'Reset Password'}
          </h1>
          <p className="text-xs text-[#938f98] leading-relaxed">
            {isSubmitted
              ? `We sent password reset instructions to ${email}`
              : 'Enter your registered email address and we will send you a password reset link.'}
          </p>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-start gap-2.5 animate-in fade-in">
            <span className="material-symbols-outlined text-[18px] text-red-400 shrink-0">error</span>
            <span className="leading-tight">{errorMsg}</span>
          </div>
        )}

        {isSubmitted ? (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-[#1c1e26]/80 border border-[#48454d]/40 text-xs font-mono text-[#cac5ce] space-y-2">
              <div className="flex items-center gap-2 text-[#fbcfe8] font-bold">
                <span className="material-symbols-outlined text-[18px]">info</span>
                <span>Next steps:</span>
              </div>
              <ol className="list-decimal list-inside space-y-1.5 text-[#938f98] pl-1">
                <li>Check your inbox (and spam/junk folder) for an email from Supabase.</li>
                <li>Click the reset link in the email to open the password reset form.</li>
                <li>Choose a new secure password.</li>
              </ol>
            </div>

            <div className="pt-2 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => handleResetRequest()}
                disabled={loading || cooldown > 0}
                className="w-full py-2.5 px-4 rounded-xl bg-[#1c1e26] hover:bg-[#252833] border border-[#48454d]/40 text-[#e3e2e6] hover:text-white text-xs font-mono font-medium transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    <span>Resending...</span>
                  </>
                ) : cooldown > 0 ? (
                  <span>Resend email in {cooldown}s</span>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[16px]">replay</span>
                    <span>Resend reset email</span>
                  </>
                )}
              </button>

              <Link
                href="/login"
                className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-[#70485c] to-[#49273c] hover:from-[#82546c] hover:to-[#573047] border border-[#fbcfe8]/40 text-white text-xs font-mono font-bold transition-all shadow-lg hover:shadow-[#fbcfe8]/20 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                <span>Back to Sign In</span>
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleResetRequest} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-[#cac5ce] uppercase tracking-wider block">
                Email Address
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#938f98] text-[18px]">
                  mail
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  required
                  autoFocus
                  className="w-full bg-[#1c1e26] border border-[#48454d]/40 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder:text-[#6a6770] focus:border-[#fbcfe8]/70 focus:outline-none transition-all shadow-inner font-mono"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-[#70485c] to-[#49273c] hover:from-[#82546c] hover:to-[#573047] border border-[#fbcfe8]/40 text-white text-xs font-mono font-bold transition-all shadow-lg hover:shadow-[#fbcfe8]/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>Sending reset link...</span>
                </>
              ) : (
                <>
                  <span>Send Reset Link</span>
                  <span className="material-symbols-outlined text-[16px]">send</span>
                </>
              )}
            </button>

            <div className="text-center pt-2 border-t border-[#48454d]/25">
              <p className="text-xs text-[#938f98]">
                Remember your password?{' '}
                <Link
                  href="/login"
                  className="text-[#fbcfe8] hover:underline font-medium font-mono"
                >
                  Back to Sign In
                </Link>
              </p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
