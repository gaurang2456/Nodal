'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please enter both email and password.');
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
    setSuccessMsg(null);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });

      if (error) {
        if (error.message.toLowerCase().includes('already registered')) {
          setErrorMsg('An account with this email address already exists.');
        } else if (error.message.toLowerCase().includes('password')) {
          setErrorMsg('Weak password. Please use at least 6 characters with mixed letters/numbers.');
        } else {
          setErrorMsg(error.message || 'Signup failed. Please try again.');
        }
        return;
      }

      if (data.session) {
        // Automatically signed in
        router.push('/');
      } else if (data.user) {
        // Email confirmation required by Supabase project settings
        setSuccessMsg('Account created successfully! Please check your email inbox to confirm your account, then log in.');
      }
    } catch (err: any) {
      console.error('Signup error:', err);
      setErrorMsg('An unexpected connection error occurred. Please try again.');
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
            <span className="material-symbols-outlined text-[26px]">hub</span>
          </div>
          <h1 className="text-2xl font-heading font-bold text-white tracking-tight">
            Create Nodal Account
          </h1>
          <p className="text-xs text-[#938f98] leading-relaxed">
            Index, visualize, and interact with your private repositories
          </p>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-start gap-2.5 animate-in fade-in">
            <span className="material-symbols-outlined text-[18px] text-red-400 shrink-0">error</span>
            <span className="leading-tight">{errorMsg}</span>
          </div>
        )}

        {/* Success Alert */}
        {successMsg && (
          <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-start gap-2.5 animate-in fade-in">
            <span className="material-symbols-outlined text-[18px] text-emerald-400 shrink-0">check_circle</span>
            <span className="leading-tight">{successMsg}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSignup} className="space-y-4">
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
            <label className="text-[11px] font-mono text-[#cac5ce] uppercase tracking-wider block">
              Password (min 6 characters)
            </label>
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

          <div className="space-y-1.5">
            <label className="text-[11px] font-mono text-[#cac5ce] uppercase tracking-wider block">
              Confirm Password
            </label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#938f98] text-[18px]">
                lock_reset
              </span>
              <input
                type="password"
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
                <span>Creating Account...</span>
              </>
            ) : (
              <>
                <span>Create Account</span>
                <span className="material-symbols-outlined text-[16px]">person_add</span>
              </>
            )}
          </button>
        </form>

        {/* Footer Link */}
        <div className="text-center pt-2 border-t border-[#48454d]/25">
          <p className="text-xs text-[#938f98]">
            Already have an account?{' '}
            <Link
              href="/login"
              className="text-[#fbcfe8] hover:underline font-medium font-mono"
            >
              Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
