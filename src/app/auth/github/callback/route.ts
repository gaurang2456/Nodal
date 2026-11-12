import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { GitHubConnectionService } from '@/server/github/githubConnectionService';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const errorParam = searchParams.get('error');

  const forwardedHost = request.headers.get('x-forwarded-host');
  const isLocalEnv = process.env.NODE_ENV === 'development';
  const redirectBase = isLocalEnv || !forwardedHost ? origin : `https://${forwardedHost}`;

  // Handle provider cancellation or denial
  if (errorParam) {
    return NextResponse.redirect(`${redirectBase}/?github_error=oauth_denied`);
  }

  // Step 1: Read the OAuth code
  if (!code) {
    return NextResponse.redirect(`${redirectBase}/?github_error=missing_code`);
  }

  try {
    // Step 2: Exchange code using the existing Supabase server client
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data?.session) {
      console.warn('[GitHub OAuth Callback] Exchange code for session failed:', error?.message || 'No session returned');
      return NextResponse.redirect(`${redirectBase}/?github_error=exchange_failed`);
    }

    // Step 3: Retrieve authenticated Nodal user
    const user = data.session.user;
    if (!user || !user.id) {
      return NextResponse.redirect(`${redirectBase}/?github_error=no_user`);
    }

    // Step 4: Extract the GitHub provider token from the session
    const providerToken = data.session.provider_token;
    if (!providerToken) {
      console.warn('[GitHub OAuth Callback] No provider_token present in session.');
      return NextResponse.redirect(`${redirectBase}/?github_error=missing_provider_token`);
    }

    // Step 5: Call GET https://api.github.com/user using provider token
    const ghRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${providerToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Nodal-Platform/1.0',
      },
    });

    if (!ghRes.ok) {
      console.warn('[GitHub OAuth Callback] GitHub user profile request failed with status:', ghRes.status);
      return NextResponse.redirect(`${redirectBase}/?github_error=profile_fetch_failed`);
    }

    const ghUser = await ghRes.json();

    if (!ghUser?.id || !ghUser?.login) {
      return NextResponse.redirect(`${redirectBase}/?github_error=invalid_github_profile`);
    }

    // Step 6: Store the GitHub connection safely in database
    await GitHubConnectionService.connectGitHubAccount({
      userId: user.id,
      githubUserId: String(ghUser.id),
      githubLogin: ghUser.login,
      accessToken: providerToken,
      avatarUrl: ghUser.avatar_url || null,
    });

    // Step 7: Redirect safely to /?github_connected=true
    return NextResponse.redirect(`${redirectBase}/?github_connected=true`);
  } catch (err: any) {
    console.error('[GitHub OAuth Callback] Unexpected error during connection flow');
    return NextResponse.redirect(`${redirectBase}/?github_error=server_error`);
  }
}
