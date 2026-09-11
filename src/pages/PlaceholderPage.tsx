import { AppFrame } from "../components/AppFrame";

type PlaceholderPageProps = {
  eyebrow: string;
  title: string;
};

export function PlaceholderPage({ eyebrow, title }: PlaceholderPageProps) {
  return (
    <AppFrame eyebrow={eyebrow} title={title}>
      <section className="protocol-panel placeholder-panel" aria-label={`${title} content`} />
    </AppFrame>
  );
}
