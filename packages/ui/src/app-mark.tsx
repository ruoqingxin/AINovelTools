type AppMarkProps = {
  className?: string;
};

export function AppMark({ className }: AppMarkProps) {
  return (
    <span className={className} aria-hidden="true">
      文
    </span>
  );
}
