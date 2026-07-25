/**
 * Shared Clerk `appearance` config for /sign-in and /sign-up.
 *
 * Why this exists: Clerk's default card ships its own white background,
 * border and drop shadow. Dropping that straight onto the sky photograph
 * gives you a card inside a card — the glass frame in <AuthShell /> already
 * provides the surface. So here we strip Clerk's own box chrome and let the
 * shell own the elevation, then re-skin the controls with the app's tokens
 * (charcoal primary, 1rem radius, Geist type stack) so the auth screen reads
 * as part of the product rather than a third-party embed.
 *
 * Deliberately NOT typed as `Appearance` from '@clerk/types': that package is
 * a transitive dependency, not a direct one, and importing it directly would
 * break if @clerk/nextjs ever hoists a different version. Structural typing
 * covers us at the call site.
 */
export const clerkAuthAppearance = {
  layout: {
    socialButtonsPlacement: 'top' as const,
    socialButtonsVariant: 'blockButton' as const,
    showOptionalFields: false,
    // The shell renders its own Terms/Privacy line beneath the card.
    privacyPageUrl: '/privacy',
    termsPageUrl: '/terms',
  },
  variables: {
    // Card is always forced light (see AuthShell), so pin Clerk's own
    // colorScheme too. Without this, Clerk auto-adapts to the OS/browser
    // dark-mode preference and silently overrides our text colors below
    // with its dark-theme whites — invisible on this light card.
    colorScheme: 'light',
    colorPrimary: '#1a1a1a',
    colorText: '#1a1a1a',
    colorTextSecondary: '#5c5c5c',
    colorBackground: 'transparent',
    colorInputBackground: '#ffffff',
    colorInputText: '#1a1a1a',
    colorDanger: '#c0392b',
    borderRadius: '0.75rem',
    fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
    fontSize: '0.9375rem',
    spacingUnit: '1rem',
  },
  elements: {
    // Kill Clerk's own card chrome — AuthShell's glass panel is the surface.
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none border-none rounded-[1.25rem] bg-transparent',
    card: 'w-full shadow-none border-none bg-transparent px-6 py-7',

    header: 'gap-1',
    headerTitle: 'text-2xl font-display tracking-tight text-slate-900',
    headerSubtitle: 'text-sm text-slate-500',

    socialButtonsBlockButton:
      'h-11 rounded-xl border border-slate-200 bg-white text-slate-800 shadow-xs transition-colors hover:bg-slate-50',
    socialButtonsBlockButtonText: 'text-sm font-medium',

    dividerLine: 'bg-slate-200',
    dividerText: 'text-xs uppercase tracking-widest text-slate-400',

    formFieldLabel: 'text-sm font-medium text-slate-700',
    formFieldInput:
      'h-11 rounded-xl border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-900/15',
    formFieldInputShowPasswordButton: 'text-slate-400 hover:text-slate-700',
    formFieldAction: 'text-slate-600 hover:text-slate-900',

    formButtonPrimary:
      'h-11 rounded-xl bg-slate-900 text-sm font-medium normal-case tracking-normal text-white shadow-sm transition-colors hover:bg-slate-800 focus:ring-2 focus:ring-slate-900/25',

    otpCodeFieldInput: 'rounded-xl border-slate-200 text-slate-900',
    formResendCodeLink: 'text-slate-700 hover:text-slate-900',
    identityPreviewText: 'text-slate-700',
    identityPreviewEditButton: 'text-slate-600 hover:text-slate-900',

    footer: 'bg-transparent',
    footerAction: 'bg-transparent',
    footerActionText: 'text-sm text-slate-500',
    footerActionLink: 'text-sm font-medium text-slate-900 underline-offset-4 hover:underline',
  },
}
