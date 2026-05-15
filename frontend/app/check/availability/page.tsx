"use client";
import { PillarStubPage } from "@/components/pillar-stub-page";
import { useT } from "@/lib/i18n";

export default function CheckAvailabilityPage() {
  const { t } = useT();
  return (
    <PillarStubPage
      title={t.pages.checkAvailability.title}
      subtitle={t.pages.checkAvailability.subtitle}
      wave="wave_3"
    />
  );
}
