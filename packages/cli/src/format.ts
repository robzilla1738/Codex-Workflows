export const formatCount = (value: number) => {
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return String(Math.round(value));
};

export const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${rest}s`;
  }
  return `${rest}s`;
};

export const truncateMiddle = (value: string, width: number) => {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, Math.max(1, width - 1))}…`;
};

export const padRight = (value: string, width: number) => value.padEnd(width).slice(0, width);
