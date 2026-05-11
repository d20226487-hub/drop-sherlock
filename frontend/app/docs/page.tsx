import Link from "next/link";

export const metadata = { title: "Документация — Drop Sherlock" };

const QUICK_LINKS: { slug: string; title: string; description: string }[] = [
  {
    slug: "workflow",
    title: "Рабочий процесс drop-hunter",
    description:
      "Полный путь от загрузки списка доменов до покупки. Начните отсюда, если запускаете инструмент впервые.",
  },
  {
    slug: "backlog",
    title: "Очередь (Backlog)",
    description:
      "Импорт сырых списков, фильтры, цены, статусы, кнопка «Отправить на анализ».",
  },
  {
    slug: "analyze",
    title: "Анализ",
    description:
      "Форма запуска: какие критерии включать, какую модель брать, как работают флаги кэша.",
  },
  {
    slug: "database",
    title: "База",
    description:
      "Перекрёстный обзор всех проанализированных доменов. Здесь вы выбираете победителей.",
  },
  {
    slug: "brain",
    title: "Brain — Scoring и Prompts",
    description:
      "Как из четырёх ИИ-вердиктов получается единый балл и как настроить промпты.",
  },
  {
    slug: "cache",
    title: "Кэш",
    description:
      "Почему домен иногда не обращается к Ahrefs повторно и где включить переиспользование.",
  },
];

export default function DocsIndex() {
  return (
    <div className="docs-content">
      <h1>Документация Drop Sherlock</h1>
      <p>
        Drop Sherlock — это инструмент для триажа дропов: вы загружаете сырые
        списки доменов, прогоняете их через Ahrefs и нескольких ИИ-судей,
        получаете объяснимый итоговый балл и решаете, какие домены покупать
        под линкбилдинг.
      </p>
      <p>
        Документация рассказывает, как пользоваться каждым разделом и как
        собрать их в один рабочий процесс. Все статьи на русском языке —
        переключатель EN/RU в шапке меняет интерфейс, но не документацию.
      </p>

      <h2>С чего начать</h2>
      <p>
        Если вы впервые работаете с инструментом, прочитайте сначала{" "}
        <Link href="/docs/workflow">«Рабочий процесс drop-hunter»</Link>. Это
        большая статья, в которой описан полный путь от загрузки до покупки —
        остальные разделы документации ссылаются на её этапы.
      </p>

      <h2>Быстрая навигация</h2>
      <div className="not-prose grid grid-cols-1 md:grid-cols-2 gap-3 my-4">
        {QUICK_LINKS.map((link) => (
          <Link
            key={link.slug}
            href={`/docs/${link.slug}`}
            className="block rounded-md border dark:border-neutral-800 p-4 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors no-underline"
          >
            <div className="font-medium text-blue-700 dark:text-blue-300 mb-1">
              {link.title}
            </div>
            <div className="text-sm text-neutral-600 dark:text-neutral-400">
              {link.description}
            </div>
          </Link>
        ))}
      </div>

      <h2>Как организована документация</h2>
      <ul>
        <li>
          <strong>Рабочий процесс</strong> — один сквозной сценарий
          использования.
        </li>
        <li>
          <strong>Разделы интерфейса</strong> — короткие справочники по каждой
          странице приложения (Очередь, Анализ, Задачи и т.&nbsp;д.).
        </li>
        <li>
          <strong>Концепции</strong> — углублённые статьи про вещи, которые
          встречаются повсюду: кэш, закрепление, Brain, провайдеры ИИ, Wayback
          Classify, переоценка.
        </li>
        <li>
          <strong>Дополнительно</strong> — узкие темы: импорт/экспорт CSV,
          резервные копии, цепочка augmentation.
        </li>
      </ul>
    </div>
  );
}
