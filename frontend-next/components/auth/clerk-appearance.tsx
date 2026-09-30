/**
 * Clerk `appearance` for /sign-in and /sign-up. Strips Clerk's own card
 * chrome (AuthShell provides the surface) and applies the app's tokens.
 * Not typed as `Appearance` since @clerk/types is only a transitive dep.
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
    // The card is always light (see AuthShell); pin Clerk's scheme so OS
    // dark mode doesn't turn its text white.
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
    // Kill Clerk's own card chrome, AuthShell's panel is the surface.
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
