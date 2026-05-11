"use client";

export function PageStub({
  title,
  intro,
  placeholder,
}: {
  title: string;
  intro: string;
  placeholder: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {intro}
        </p>
      </div>
      <div className="rounded-md border border-dashed dark:border-neutral-700 p-6 text-sm text-neutral-500 dark:text-neutral-400">
        {placeholder}
      </div>
    </div>
  );
}
