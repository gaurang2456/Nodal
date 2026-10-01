'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('reset') === 'success') {
        setSuccessMsg('Your password was updated successfully. Please sign in with your new password.');
      }
    }
  }, []);

  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        if (error.message.toLowerCase().includes('invalid login credentials')) {
          setErrorMsg('Invalid email or password. Please check your credentials and try again.');
        } else if (error.message.toLowerCase().includes('email not confirmed')) {
          setErrorMsg('Please verify your email address before logging in.');
        } else {
          setErrorMsg(error.message || 'Login failed. Please try again.');
        }
        return;
      }

      if (data.user) {
        router.push('/');
      }
    } catch (err: any) {
      console.error('Login error:', err);
      setErrorMsg('An unexpected connection error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setOauthLoading(true);
    setErrorMsg(null);
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/auth/callback`,
        },
      });

      if (error) {
        setErrorMsg('Google login could not be initiated. Please try again or use email/password.');
        setOauthLoading(false);
      }
    } catch (err) {
      console.error('OAuth error:', err);
      setErrorMsg('Google login is currently unavailable.');
      setOauthLoading(false);
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
            <span className="material-symbols-outlined text-[26px]">hub</span>
          </div>
          <h1 className="text-2xl font-heading font-bold text-white tracking-tight">
            Sign In to CodeGraph
          </h1>
          <p className="text-xs text-[#938f98] leading-relaxed">
            AST-powered code intelligence, relationships & architecture graph
          </p>
        </div>

        {/* Success Alert */}
        {successMsg && (
          <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-start gap-2.5 animate-in fade-in">
            <span className="material-symbols-outlined text-[18px] text-emerald-400 shrink-0">check_circle</span>
            <span className="leading-tight">{successMsg}</span>
          </div>
        )}

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-start gap-2.5 animate-in fade-in">
            <span className="material-symbols-outlined text-[18px] text-red-400 shrink-0">error</span>
            <span className="leading-tight">{errorMsg}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleLogin} className="space-y-4">
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
                className="w-full bg-[#1c1e26] border border-[#48454d]/40 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder:text-[#6a6770] focus:border-[#fbcfe8]/70 focus:outline-none transition-all shadow-inner font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-mono text-[#cac5ce] uppercase tracking-wider block">
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-[11px] font-mono text-[#fbcfe8] hover:underline transition-colors"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#938f98] text-[18px]">
                lock
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
                className="w-full bg-[#1c1e26] border border-[#48454d]/40 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white placeholder:text-[#6a6770] focus:border-[#fbcfe8]/70 focus:outline-none transition-all shadow-inner font-mono"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || oauthLoading}
            className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-[#70485c] to-[#49273c] hover:from-[#82546c] hover:to-[#573047] border border-[#fbcfe8]/40 text-white text-xs font-mono font-bold transition-all shadow-lg hover:shadow-[#fbcfe8]/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                <span>Signing In...</span>
              </>
            ) : (
              <>
                <span>Sign In</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </>
            )}
          </button>
        </form>

        {/* Divider */}
        <div className="relative flex items-center justify-center">
          <div className="border-t border-[#48454d]/30 w-full" />
          <span className="bg-[#13151b] px-3 text-[10px] font-mono text-[#938f98] uppercase tracking-widest absolute">
            or
          </span>
        </div>

        {/* Google OAuth Button */}
        <button
          onClick={handleGoogleLogin}
          disabled={loading || oauthLoading}
          type="button"
          className="w-full py-2.5 px-4 rounded-xl bg-[#1c1e26] hover:bg-[#252833] border border-[#48454d]/40 text-[#e3e2e6] hover:text-white text-xs font-mono font-medium transition-all flex items-center justify-center gap-2.5 cursor-pointer shadow-sm disabled:opacity-50"
        >
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.66v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.15z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.24v3.15C3.26 21.36 7.33 24 12 24z"
            />
            <path
              fill="#FBBC05"
              d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.24C.45 8.15 0 9.92 0 12s.45 3.85 1.24 5.42l4.04-3.15z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.24 6.58l4.04 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
            />
          </svg>
          <span>Continue with Google</span>
        </button>

        {/* Footer Link */}
        <div className="text-center pt-2">
          <p className="text-xs text-[#938f98]">
            Don&apos;t have an account?{' '}
            <Link
              href="/signup"
              className="text-[#fbcfe8] hover:underline font-medium font-mono"
            >
              Sign Up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
