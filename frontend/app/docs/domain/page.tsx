import Link from "next/link";

export const metadata = { title: "Страница домена — Drop Sherlock" };

export default function DomainDoc() {
  return (
    <div className="docs-content">
      <h1>Страница домена</h1>
      <p>
        Самая информативная страница инструмента. Здесь вы решаете «брать
        или не брать» по одному домену: видите финальный балл с
        обоснованием, четыре ИИ-вердикта с key_findings и red_flags, сырые
        Ahrefs-строки в табах, таймлайн Wayback-снепшотов.
      </p>

      <h2>Шапка</h2>
      <ul>
        <li>
          Домен + хлебные крошки (Job → Run → Domain).
        </li>
        <li>
          Чип со ссылкой на закреплённый RunDomain (если этот домен где-то
          закреплён в Базе).
        </li>
        <li>
          Статус и время <code>last_analyzed_at</code>.
        </li>
        <li>
          <strong>Заметка по домену</strong> — кроссранный комментарий,
          переживает rerun-ы. Поле «Note» хранится по доменному ключу, не
          по RunDomain.
        </li>
      </ul>

      <h2>Final assessment (баннер)</h2>
      <p>
        Большая цветная плашка под шапкой:
      </p>
      <ul>
        <li>
          Бакет (good / mixed / low_quality) и финальный балл (0–100).
        </li>
        <li>
          Confidence — насколько уверены сами ИИ-судьи. При низкой
          уверенности балл показывается серым.
        </li>
        <li>
          Provider / Model — кто посчитал final synth.
        </li>
        <li>
          Короткое summary и actionable recommendation на одну фразу.
        </li>
      </ul>
      <p>
        Состояния баннера:
      </p>
      <ul>
        <li>
          <strong>«Final pending…»</strong> — обычный run всё ещё идёт,
          вердикты ещё не сошлись. Не путаем со stale-баннером (см.
          ниже).
        </li>
        <li>
          <strong>«Partial»</strong> — хотя бы один из критериев упал.
          Drop Sherlock <em>сознательно</em> не считает финальный балл и
          не вызывает ИИ для summary: оба были бы вычислены на неполных
          данных и ввели бы в заблуждение. Нажмите Reanalyze, чтобы
          переоценить.
        </li>
        <li>
          <strong>«Showing final from Run #N»</strong> — если у текущего
          RunDomain нет финала (например, запуск был частичный, только
          wayback_classify), и этот run уже <code>done</code>, баннер
          подтягивает финал из самого свежего «полного» RunDomain того
          же домена. В этом случае внизу баннера видна янтарная подпись с
          номером run-источника. Во время <em>идущего</em> запуска такая
          подмена не делается — увидите «Final pending…».
        </li>
      </ul>

      <h2>ИИ-вердикты (Section 2)</h2>
      <p>
        Под баннером — сетка боксов по одному на каждый успешно
        отработавший критерий. В каждом боксе:
      </p>
      <ul>
        <li>
          <strong>Assessment</strong> — high_quality / mixed / low_quality.
        </li>
        <li>
          <strong>Confidence</strong> — уверенность ИИ.
        </li>
        <li>
          <strong>Key findings</strong> — что хорошего ИИ увидел.
        </li>
        <li>
          <strong>Red flags</strong> — что насторожило.
        </li>
        <li>
          Провайдер/модель, чип «from Run #N», если данные пришли из
          augmentation (см.{" "}
          <Link href="/docs/augmentation">отдельную статью</Link>).
        </li>
        <li>
          Кнопка <strong>«Re-judge»</strong> для переоценки только этого
          критерия (см. <Link href="/docs/reanalyze">«Переоценка»</Link>).
        </li>
        <li>
          Раскрывающийся блок <strong>«AI input preview»</strong> — точный
          системный промпт и user message, которые ушли в ИИ. Удобно для
          отладки промптов.
        </li>
      </ul>

      <h2>Wayback-вкладка</h2>
      <p>
        Если у домена есть Wayback-данные, во вкладке <strong>Wayback</strong>{" "}
        две секции:
      </p>
      <ul>
        <li>
          <strong>Snapshot timeline (V2)</strong> — каждая запись = одна
          архивная страница: title, h1/h2/h3, первые 150 символов текста,
          скриншот недоступен. Это та же выборка, которую ИИ-судья
          использовал для оценки тематического дрифта. В шапке таймлайна
          может быть фиолетовая пилюля «Reused from Run #N», если
          Wayback-данные пришли из кэша (см.{" "}
          <Link href="/docs/cache">«Кэш»</Link>).
        </li>
        <li>
          <strong>CDX rows</strong> — свёрнут по умолчанию. Сырая таблица
          снепшотов: timestamp, original URL, statuscode, mimetype, length.
          На странице та же фиолетовая пилюля с источником кэша.
        </li>
      </ul>

      <h2>Сырые Ahrefs-табы</h2>
      <p>
        Под Wayback идут табы Backlinks / Refdomains / Anchors / Keywords —
        в каждом таблица сырых строк из Ahrefs (теми же полями, что ушли
        в ИИ). Колонки кликабельны для сортировки. Подсвечены поля,
        по которым исходно сортировалось API (амбер фон). Расшифровка
        полей и логика оценки — в статье{" "}
        <Link href="/docs/ahrefs-criteria">«Ahrefs-критерии»</Link>.
      </p>
      <p>
        Здесь полезно ходить, когда ИИ выдал странный вердикт и хочется
        своими глазами увидеть, что именно лежало в основе.
      </p>

      <h2>Pin (закрепление RunDomain)</h2>
      <p>
        В шапке есть кнопка{" "}
        <strong>«Pin this RunDomain as canonical»</strong>. Это уровень
        Базы: вы говорите «вот этот конкретный RunDomain (из этого run) —
        источник истины для домена в Базе». При повторных анализах того же
        домена закрепление не теряется — оно явно ваше решение.
      </p>
      <p>
        Разница между этим и закреплением запуска целиком — в статье{" "}
        <Link href="/docs/pinning">«Закрепление»</Link>.
      </p>

      <h2>Reanalyze</h2>
      <p>
        Внизу страницы — <strong>«Reanalyze with AI»</strong>. Заново
        вызывает ИИ-судей по всем критериям этого домена. Можно выбрать
        провайдера и модель, отличные от исходных. Ahrefs-данные не
        перекачиваются. Подробности — в{" "}
        <Link href="/docs/reanalyze">«Переоценка»</Link>.
      </p>
    </div>
  );
}
