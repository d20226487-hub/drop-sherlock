"use client";
import { PillarStubPage } from "@/components/pillar-stub-page";
import { useT } from "@/lib/i18n";

export default function JobsAvailabilityPage() {
  const { t } = useT();
  return (
    <PillarStubPage
      title={t.pages.jobsAvailability.title}
      subtitle={t.pages.jobsAvailability.subtitle}
      wave="wave_3"
    />
  );
}
