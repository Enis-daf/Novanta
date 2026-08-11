export default function IconCalculatrice({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="8" y1="11" x2="8" y2="11.01" />
      <line x1="12" y1="11" x2="12" y2="11.01" />
      <line x1="16" y1="11" x2="16" y2="11.01" />
      <line x1="8" y1="15" x2="8" y2="15.01" />
      <line x1="12" y1="15" x2="12" y2="15.01" />
      <line x1="16" y1="15" x2="16" y2="15.01" />
      <line x1="8" y1="19" x2="8" y2="19.01" />
      <line x1="12" y1="19" x2="12" y2="19.01" />
      <line x1="16" y1="19" x2="16" y2="19.01" />
    </svg>
  );
}
