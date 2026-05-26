import { render, fireEvent } from '@testing-library/react';
import Card from './Card';

describe('Card component', () => {
  const baseProps = {
    title: 'Hello',
    description: 'World',
    choices: [
      { text: 'Yes', effects: {} },
      { text: 'No', effects: {} }
    ],
    onChoice: vi.fn()
  };

  test('renders title and description', () => {
    const { getByText } = render(<Card {...baseProps} />);
    expect(getByText('Hello')).toBeInTheDocument();
    expect(getByText('World')).toBeInTheDocument();
  });

  test('calls onChoice when clicked with hovered choice', () => {
    const { container } = render(<Card {...baseProps} />);
    const cardDiv = container.querySelector('.card-container');
    fireEvent.mouseMove(cardDiv, { clientX: 1000 });
    fireEvent.click(cardDiv);
    expect(baseProps.onChoice).toHaveBeenCalled();
  });
});
