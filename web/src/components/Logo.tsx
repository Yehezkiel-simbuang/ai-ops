/** Logo AI Ops: hexagon (server/node) dengan garis denyut (monitoring). Warna mengikuti tema lewat currentColor dan --accent. */
export function Logo({ size = 28, title = 'AI Ops' }: { size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
      <path d="M16 3.5 26.8 9.75v12.5L16 28.5 5.2 22.25V9.75z" stroke="currentColor" />
      <path d="M8.5 17h4l2-5.5 3.2 10 2.3-4.5h3.5" stroke="var(--accent)" />
    </svg>
  );
}
