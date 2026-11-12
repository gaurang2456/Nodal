'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verifyingSession, setVerifyingSession] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const supabase = createClient();

  useEffect(() => {
    async function checkSession() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          setHasSession(true);
        } else {
          // Listen for auth state change in case code exchange or hash fragment is finishing
          const { data: authListener } = supabase.auth.onAuthStateChange((event, s) => {
            if (s || event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
              setHasSession(true);
              setVerifyingSession(false);
            }
          });
          // Allow a brief grace period for Supabase auth to initialize
          setTimeout(() => {
            setVerifyingSession(false);
          }, 1500);

          return () => {
            authListener.subscription.unsubscribe();
          };
        }
      } catch (err) {
        console.error('Session check error:', err);
      } finally {
        setVerifyingSession(false);
      }
    }

    checkSession();
  }, [supabase]);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || !confirmPassword) {
      setErrorMsg('Please enter and confirm your new password.');
      return;
    }

    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setErrorMsg('Passwords do not match.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const { error } = await supabase.auth.updateUser({
        password,
      });

      if (error) {
        setErrorMsg(error.message || 'Failed to update password. Your reset link may have expired.');
        return;
      }

      setSuccess(true);
    } catch (err: any) {
      console.error('Password update error:', err);
      setErrorMsg('An unexpected error occurred while updating password.');
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
              {success ? 'check_circle' : 'key'}
            </span>
          </div>
          <h1 className="text-2xl font-heading font-bold text-white tracking-tight">
            {success ? 'Password Reset Complete' : 'Set New Password'}
          </h1>
          <p className="text-xs text-[#938f98] leading-relaxed">
            {success
              ? 'Your password has been changed successfully. You can now use your new password.'
              : 'Please enter a strong new password for your Nodal account.'}
          </p>
        </div>

        {/* Verifying Session Loading State */}
        {verifyingSession && (
          <div className="py-6 flex flex-col items-center justify-center gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-[#fbcfe8] border-t-transparent animate-spin" />
            <span className="text-xs font-mono text-[#938f98]">Verifying reset authorization...</span>
          </div>
        )}

        {/* Session Missing Warning (if link invalid or expired) */}
        {!verifyingSession && !hasSession && !success && (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono space-y-2">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <span className="material-symbols-outlined text-[18px]">warning</span>
                <span>Reset Link Expired or Invalid</span>
              </div>
              <p className="text-[#cac5ce] leading-relaxed">
                We couldn&apos;t detect an active password recovery session. Password reset links expire after 1 hour or after being used.
              </p>
            </div>

            <Link
              href="/forgot-password"
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-[#70485c] to-[#49273c] hover:from-[#82546c] hover:to-[#573047] border border-[#fbcfe8]/40 text-white text-xs font-mono font-bold transition-all shadow-lg hover:shadow-[#fbcfe8]/20 flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              <span>Request New Reset Link</span>
            </Link>

            <div className="text-center pt-2">
              <Link href="/login" className="text-xs text-[#938f98] hover:text-[#fbcfe8] font-mono">
                ← Back to Sign In
              </Link>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-start gap-2.5 animate-in fade-in">
            <span className="material-symbols-outlined text-[18px] text-red-400 shrink-0">error</span>
            <span className="leading-tight">{errorMsg}</span>
          </div>
        )}

        {/* Success View */}
        {success && (
          <div className="space-y-4 pt-2">
            <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[20px] text-emerald-400 shrink-0">verified</span>
              <span>Your password has been updated! You can now access your account.</span>
            </div>

            <div className="flex flex-col gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => router.push('/')}
                className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-[#70485c] to-[#49273c] hover:from-[#82546c] hover:to-[#573047] border border-[#fbcfe8]/40 text-white text-xs font-mono font-bold transition-all shadow-lg hover:shadow-[#fbcfe8]/20 flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>Continue to Nodal</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </button>

              <button
                type="button"
                onClick={async () => {
                  await supabase.auth.signOut();
                  router.push('/login?reset=success');
                }}
                className="w-full py-2.5 px-4 rounded-xl bg-[#1c1e26] hover:bg-[#252833] border border-[#48454d]/40 text-[#cac5ce] hover:text-white text-xs font-mono transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">login</span>
                <span>Sign In with New Password</span>
              </button>
            </div>
          </div>
        )}

        {/* Password Form (only when session active and not yet success) */}
        {!verifyingSession && hasSession && !success && (
          <form onSubmit={handleUpdatePassword} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-[#cac5ce] uppercase tracking-wider block">
                New Password (min 6 characters)
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#938f98] text-[18px]">
                  lock
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  autoFocus
                  className="w-full bg-[#1c1e26] border border-[#48454d]/40 rounded-xl pl-10 pr-10 py-2.5 text-xs text-white placeholder:text-[#6a6770] focus:border-[#fbcfe8]/70 focus:outline-none transition-all shadow-inner font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#938f98] hover:text-white transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-[#cac5ce] uppercase tracking-wider block">
                Confirm New Password
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#938f98] text-[18px]">
                  lock_reset
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
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
                  <span>Updating Password...</span>
                </>
              ) : (
                <>
                  <span>Save New Password</span>
                  <span className="material-symbols-outlined text-[16px]">check</span>
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
