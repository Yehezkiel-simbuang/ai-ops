import { render, screen } from '@testing-library/react';
import { Logo } from './Logo';

describe('Logo', () => {
  it('bernama AI Ops bagi pembaca layar; tanpa judul dianggap hiasan', () => {
    const { unmount } = render(<Logo />);
    expect(screen.getByRole('img', { name: 'AI Ops' })).toBeInTheDocument(); unmount();
    const { container } = render(<Logo title="" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
