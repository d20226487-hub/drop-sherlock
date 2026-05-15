"use client";
import { PillarStubPage } from "@/components/pillar-stub-page";
import { useT } from "@/lib/i18n";

export default function CheckWhoisHistoryPage() {
  const { t } = useT();
  return (
    <PillarStubPage
      title={t.pages.checkWhoisHistory.title}
      subtitle={t.pages.checkWhoisHistory.subtitle}
      wave="wave_2"
    />
  );
}
