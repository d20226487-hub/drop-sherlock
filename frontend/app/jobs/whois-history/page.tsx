"use client";
import { PillarStubPage } from "@/components/pillar-stub-page";
import { useT } from "@/lib/i18n";

export default function JobsWhoisHistoryPage() {
  const { t } = useT();
  return (
    <PillarStubPage
      title={t.pages.jobsWhoisHistory.title}
      subtitle={t.pages.jobsWhoisHistory.subtitle}
      wave="wave_2"
    />
  );
}
