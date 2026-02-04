import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GifCard } from './GifCard';
import type { GifResult } from '../lib/antfly';

const mockGif: GifResult = {
  id: 'test-gif-1',
  score: 0.95,
  gif_url: 'https://example.com/test.gif',
  description: 'A test gif showing something cool',
  tumblr_id: 'tumblr_abc123',
};

describe('GifCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render gif image with correct src and alt', () => {
    render(<GifCard gif={mockGif} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', mockGif.gif_url);
    expect(img).toHaveAttribute('alt', mockGif.description);
  });

  it('should show loading skeleton before image loads', () => {
    render(<GifCard gif={mockGif} />);

    // Skeleton should be visible
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();

    // Image should be transparent (opacity-0)
    const img = screen.getByRole('img');
    expect(img).toHaveClass('opacity-0');
  });

  it('should hide skeleton after image loads', () => {
    render(<GifCard gif={mockGif} />);

    const img = screen.getByRole('img');
    fireEvent.load(img);

    // Image should be visible (opacity-100)
    expect(img).toHaveClass('opacity-100');
    expect(img).not.toHaveClass('opacity-0');

    // Skeleton should be gone
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).not.toBeInTheDocument();
  });

  it('should show error state when image fails to load', () => {
    render(<GifCard gif={mockGif} />);

    const img = screen.getByRole('img');
    fireEvent.error(img);

    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('should show "No URL" when gif_url is empty', () => {
    const gifWithNoUrl = { ...mockGif, gif_url: '' };
    render(<GifCard gif={gifWithNoUrl} />);

    expect(screen.getByText('No URL')).toBeInTheDocument();
  });

  it('should display description on hover overlay', () => {
    render(<GifCard gif={mockGif} />);

    expect(screen.getByText(mockGif.description)).toBeInTheDocument();
  });

  it('should display score badge', () => {
    render(<GifCard gif={mockGif} />);

    // 0.95 * 100 = 95%
    expect(screen.getByText('95%')).toBeInTheDocument();
  });

  it('should copy URL to clipboard when Copy URL is clicked', async () => {
    const user = userEvent.setup();
    render(<GifCard gif={mockGif} />);

    const copyButton = screen.getByText('Copy URL');
    await user.click(copyButton);

    // Check that clipboard API was called (via mock)
    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });
  });

  it('should have download button', () => {
    render(<GifCard gif={mockGif} />);

    const downloadButton = screen.getByTitle('Download GIF');
    expect(downloadButton).toBeInTheDocument();
  });

  it('should use lazy loading for images', () => {
    render(<GifCard gif={mockGif} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('loading', 'lazy');
  });
});
