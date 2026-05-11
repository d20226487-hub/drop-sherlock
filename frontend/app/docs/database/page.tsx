import Link from "next/link";

export const metadata = { title: "База — Drop Sherlock" };

export default function DatabaseDoc() {
  return (
    <div className="docs-content">
      <h1>База (Database)</h1>
      <p>
        База — кроссранный обзор всех проанализированных доменов. Одна
        строка на домен независимо от того, в скольких Задачах и Запусках
        он встречался. Источник данных строки — закреплённый RunDomain
        (см. <Link href="/docs/pinning">«Закрепление»</Link>); если домен
        ни разу не закреплён, в строке видна метка «not pinned» и пустые
        колонки.
      </p>

      <h2>Когда сюда заходить</h2>
      <ul>
        <li>
          После завершения анализа — основной экран триажа. Здесь принимают
          решение Order / Discard.
        </li>
        <li>
          Чтобы пересмотреть прошлые домены под новый фильтр: например,
          «дай мне все good-домены на русском в категории недвижимости».
        </li>
        <li>
          Чтобы перезапустить выборку доменов с переиспользованием кэша
          («Analyze selected» → откроется Анализ с включённым{" "}
          <em>cross_job_cache</em>).
        </li>
      </ul>

      <h2>Колонки</h2>
      <ul>
        <li>
          <strong>Domain</strong> — клик ведёт на{" "}
          <Link href="/docs/domain">страницу домена</Link>{" "}
          (конкретно — на закреплённый RunDomain).
        </li>
        <li>
          <strong>Final / Bucket</strong> — итоговая оценка и бакет от
          закреплённого RunDomain.
        </li>
        <li>
          <strong>Confidence</strong> — уверенность ИИ.
        </li>
        <li>
          <strong>Wayback</strong> — отдельный вердикт по истории
          (high_quality / mixed / low_quality). Часто важнее общего балла:
          если Wayback показал тематический дрифт на казино, домен не
          стоит брать даже при отличных Ahrefs.
        </li>
        <li>
          <strong>Language / Theme / Category</strong> — выводы Wayback
          Classify (см. <Link href="/docs/wayback-classify">отдельную
          статью</Link>).
        </li>
        <li>
          <strong>Provider</strong> — провайдер/модель, выдавшие финал.
        </li>
        <li>
          <strong>Note</strong> — ваш кроссранный комментарий по домену.
        </li>
        <li>
          <strong>Backlog</strong> — статус в Очереди + быстрые кнопки
          Order / Discard.
        </li>
        <li>
          <strong>Criteria</strong> — зелёные пилюли{" "}
          <code>B&nbsp;D&nbsp;A&nbsp;K</code> по тем критериям, по которым
          собраны данные (на наведении — полное имя и кол-во строк).
          Что означает каждая буква:
          <ul>
            <li>
              <code>B</code> — <strong>Backlinks</strong> (входящие ссылки)
            </li>
            <li>
              <code>D</code> — <strong>refDomains</strong> (ссылающиеся
              домены)
            </li>
            <li>
              <code>A</code> — <strong>Anchors</strong> (анкоры)
            </li>
            <li>
              <code>K</code> — <strong>Keywords</strong> (органические
              ключи)
            </li>
          </ul>
          Wayback и Wayback Classify живут в отдельных колонках{" "}
          (<em>Wayback</em>, <em>Language</em>, <em>Theme</em>,{" "}
          <em>Category</em>), поэтому в столбце Criteria их буквы
          (<code>W</code>, <code>C</code>) не дублируются. Глубокий
          разбор четырёх Ahrefs-критериев — в статье{" "}
          <Link href="/docs/ahrefs-criteria">«Ahrefs-критерии»</Link>.
        </li>
        <li>
          <strong>Runs</strong> — сколько раз домен анализировался в
          истории.
        </li>
        <li>
          <strong>Pin</strong> — выбор закреплённого RunDomain (среди всех
          RunDomain того же домена). Селектор показывает варианты по
          задачам/запускам; рядом — кнопка «Unpin».
        </li>
      </ul>

      <h2>Фильтры</h2>
      <p>
        Главная сила Базы — комбинируемые фильтры. Логика AND между
        фильтрами разного типа, OR — внутри мульти-выбора.
      </p>
      <ul>
        <li>
          <strong>Verdict</strong> — bucket (good / mixed / low_quality /
          partial / no_verdict). Чаще всего: только good.
        </li>
        <li>
          <strong>Wayback verdict</strong> — отдельный фильтр для
          Wayback-оценки.
        </li>
        <li>
          <strong>Language</strong> — ISO 639-1 коды.
        </li>
        <li>
          <strong>Category</strong> — ваши пользовательские категории из{" "}
          <Link href="/docs/settings">Настроек</Link>. Удобно фильтровать
          под тематику донора.
        </li>
        <li>
          <strong>Provider / Model</strong> — отрезать вердикты от моделей,
          которым вы больше не доверяете, или наоборот оставить только
          одну.
        </li>
        <li>
          <strong>Criteria (any of)</strong> — оставить домены, у которых
          собран минимум один из выбранных критериев и хотя бы N строк.
        </li>
        <li>
          <strong>Cache</strong> — фильтр по тому, прилетели ли данные из
          кэша.
        </li>
        <li>
          <strong>Notes</strong> — «есть заметка» / «нет заметки».
        </li>
        <li>
          <strong>Pin</strong> — pinned / unpinned / any.
        </li>
        <li>
          <strong>Min records</strong> — минимум строк хоть в каком-то
          из выбранных критериев. Полезно отрезать домены с пустыми
          ответами Ahrefs.
        </li>
      </ul>

      <h2>Order / Discard и массовые действия</h2>
      <p>
        В каждой строке колонка <strong>Backlog</strong> содержит кнопки
        <strong> Order</strong> и <strong>Discard</strong>:
      </p>
      <ul>
        <li>
          <strong>Order</strong> — выставляет статус <code>order</code> в
          Очереди (создаёт строку Backlog, если её ещё не было).
        </li>
        <li>
          <strong>Discard</strong> — выставляет <code>discarded</code>.
        </li>
      </ul>
      <p>
        Те же действия доступны пакетно: галочки слева → синяя плашка
        сверху → «Order N» / «Discard N» / «Analyze selected».
      </p>

      <div className="callout callout-info docs-content">
        <p>
          <strong>Подсказка:</strong> Drop Sherlock сознательно <em>не</em>{" "}
          переключает Order → Backordered автоматически. Когда вы реально
          разместили заказ (поставили в backorder, выиграли аукцион),
          вручную перейдите в Очередь и поменяйте статус на{" "}
          <code>backordered</code>. Когда купите — на <code>bought</code>.
          Логика «только пользователь знает реальное состояние».
        </p>
      </div>

      <h2>Re-pin: выбор другого RunDomain</h2>
      <p>
        Колонка Pin — это селектор. По нажатию вы видите все RunDomain того
        же домена (с задачей, запуском и временем). Выбираете тот,
        который считаете эталонным. Это удобно, когда:
      </p>
      <ul>
        <li>
          Свежий анализ оказался слабее старого (модель сменилась, бакет
          поплыл). Возвращаем пин на старый запуск.
        </li>
        <li>
          Хотите видеть в Базе домен по конкретному запуску под аудитом.
        </li>
      </ul>

      <h2>Экспорт</h2>
      <p>
        Кнопка «Export CSV» вверху. Экспортирует <em>отфильтрованную</em>{" "}
        выборку. Формат — в статье{" "}
        <Link href="/docs/csv">«CSV: импорт и экспорт»</Link>.
      </p>

      <h2>Пагинация и серверный режим</h2>
      <p>
        При больших объёмах ({"> "}2000 доменов) включается серверная
        пагинация — Drop Sherlock не загружает всё одной пачкой, чтобы не
        вешать браузер. Опция управляется на уровне всей Базы; на меньших
        выборках всё работает клиентским сортом/фильтром.
      </p>
    </div>
  );
}
