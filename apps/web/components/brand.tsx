import Link from 'next/link';

/** The wordmark: three lanes and one crosshair through all of them. */
export function Brand({ href = '/' }: { readonly href?: string }) {
  return (
    <Link className="brand" href={href}>
      <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M2 6.5h20M2 12h20M2 17.5h20"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.45"
        />
        <path d="M14 2.5v19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="14" cy="6.5" r="2" fill="currentColor" />
        <circle cx="14" cy="12" r="2" fill="currentColor" />
        <circle cx="14" cy="17.5" r="2" fill="currentColor" />
      </svg>
      saas-dashboard
    </Link>
  );
}
