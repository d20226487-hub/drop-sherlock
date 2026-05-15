import Link from "next/link";

export const metadata = { title: "Whois History — Drop Sherlock" };

export default function WhoisHistoryDoc() {
  return (
    <div className="docs-content">
      <h1>Whois History (детектор истории дропа)</h1>
      <p>
        Whois History — это самостоятельный пилар (<code>Job.kind=
        &quot;whois_history&quot;</code>), который смотрит на полную
        историю WHOIS-записей домена и считает, насколько уверенно мы
        можем сказать, что он <em>дропался и был перерегистрирован</em>{" "}
        — то есть, что у него за плечами могут быть SEO-баггаджи
        предыдущих владельцев (фильтры, спам-история, PBN-следы).
        Это сигнал «осторожно с этим доменом», а не «не брать» —
        окончательное решение всё равно за вами. Wave 2 пилара
        задеплоилась 2026-05-15.
      </p>

      <h2>Откуда данные</h2>
      <p>
        Провайдер по умолчанию —{" "}
        <a
          href="https://whoisfreaks.com/"
          target="_blank"
          rel="noreferrer noopener"
        >
          WhoisFreaks
        </a>{" "}
        (платный, биллит за запрос; см. ниже про юниты). Архитектура
        провайдеров — абстракция <code>WhoisProvider</code> в{" "}
        <code>backend/app/whois_history/</code> — позволяет подключить
        других вендоров без изменений в runner-е, но сейчас WhoisFreaks
        — единственный реализованный.
      </p>
      <p>
        Из ответа берётся весь массив исторических WHOIS-снапшотов
        (до <code>max_records</code> штук, по умолчанию 100). Парсер
        толерантен к нескольким вариантам ключей —{" "}
        <code>whois_domains_historical</code> или <code>whois_records</code>,{" "}
        <code>country_name</code> или <code>country</code>, три варианта
        написания каждого поля дат — потому что live-ответы WhoisFreaks
        не всегда совпадают с их же документацией.
      </p>

      <h2>Diff-сигналы (что AI получает на вход)</h2>
      <p>
        Перед вызовом AI-судьи Drop Sherlock прогоняет историю через
        структурный детектор сигналов. Все они классифицируются по
        силе:
      </p>
      <h3>HARD-сигналы (сильный признак дропа)</h3>
      <ul>
        <li>
          <code>creation_date_changes</code> — дата создания изменилась
          между снапшотами. WHOIS-creation_date считается immutable
          атрибутом домена; если он сбросился, домен был удалён и
          перерегистрирован.
        </li>
        <li>
          <code>drop_pipeline_status_events</code> — фиксации
          EPP-статусов из drop-pipeline: <code>pendingDelete</code>,{" "}
          <code>redemptionPeriod</code>, <code>pendingRestore</code>,{" "}
          <code>clientHold</code>, <code>serverHold</code>,{" "}
          <code>autoRenewPeriod</code>. Появление любого из них в
          истории — твёрдое доказательство, что домен ходил через
          drop-этапы.
        </li>
        <li>
          <code>coverage_gaps_days</code> — паузы между снапшотами
          длиной от <code>coverage_gap_threshold_days</code> (по
          умолчанию 30) и больше. Долгая «дыра» в истории — частый
          признак удаления + повторной регистрации.
        </li>
      </ul>
      <h3>SOFT-сигналы (смена владельца, без однозначного дропа)</h3>
      <ul>
        <li>
          <code>owner_changes</code> / <code>email_changes</code> /{" "}
          <code>org_changes</code> / <code>country_changes</code> /{" "}
          <code>city_changes</code> — стандартные SOFT-сигналы.
        </li>
        <li>
          <code>registrar_changes</code> — смена регистратора.
        </li>
        <li>
          <code>ns_changes</code> — смена name-servers. Используется
          root-family collapse:
          <code> ns1.cloudflare.com + ns2.cloudflare.com → cloudflare.com</code>,
          чтобы рутинные ns1/ns2 ротации внутри одного хостинга не
          считались сигналом смены владельца.
        </li>
        <li>
          <code>dnssec_toggles</code> — включение/выключение DNSSEC.
        </li>
      </ul>
      <h3>CURRENT_STATE</h3>
      <p>
        Снимок последнего известного состояния (registrar, owner, org,
        country, creation_date, status, name_servers, dnssec_enabled).
        Флаг <code>is_in_drop_pipeline</code> — true если текущий
        EPP-статус из drop-pipeline списка.
      </p>

      <h2>AI-вердикт</h2>
      <p>
        AI-судья получает на вход HARD/SOFT-сигналы + current_state +
        до 30 raw-записей (для проверки edge-кейсов). Промпт
        отдельный — <code>whois_history_judge</code>, редактируется в{" "}
        <Link href="/docs/settings">Настройках → Brain → AI prompts</Link>.
      </p>
      <p>Выход:</p>
      <pre>
        <code>{`{
  "dropped_confidence": 0.92,           // 0..1, наша центральная метрика
  "transferred_confidence": 0.05,       // 0..1, был ли просто transfer
  "summary": "...",                     // 1-2 предложения
  "key_signals": ["...", "..."],        // что повлияло на confidence
  "recommendation": "..."               // что делать
}`}</code>
      </pre>

      <h2>Цветовые бэнды (важно!)</h2>
      <p>
        В drop-hunting контексте <strong>высокий dropped_confidence —
        это caution-сигнал</strong>, а не радостный исход. Домены с
        повторными дропами обычно несут SEO-баггаджи. Поэтому семантика
        цветов перевёрнута по сравнению с Quality:
      </p>
      <ul>
        <li>
          <code>&gt; 0.80</code> →{" "}
          <strong style={{ color: "#e11d48" }}>красный (dropped)</strong> —
          явные множественные дропы, осторожно.
        </li>
        <li>
          <code>&gt; 0.50, ≤ 0.80</code> →{" "}
          <strong style={{ color: "#d97706" }}>амбер (mixed)</strong> —
          смешанные сигналы.
        </li>
        <li>
          <code>≥ 0.30, ≤ 0.50</code> →{" "}
          <strong>серый (insufficient)</strong> — недостаточно
          доказательств в обе стороны.
        </li>
        <li>
          <code>&lt; 0.30</code> →{" "}
          <strong style={{ color: "#059669" }}>зелёный (stable)</strong>{" "}
          — стабильная история владения, «чистый» актив.
        </li>
      </ul>
      <p>
        Те же бэнды используются в фильтре <em>Whois verdict</em> на{" "}
        <Link href="/docs/database">Базе</Link>, в Whois-колонке Базы и
        в rollup-плашках на странице Whois-задачи.
      </p>

      <h2>Как запустить</h2>
      <p>Три точки входа:</p>
      <ul>
        <li>
          <strong>Прямой сабмит</strong> — форма{" "}
          <code>/check/whois-history</code>. Вставьте домены, выберите
          AI-провайдера, нажмите «Запустить».
        </li>
        <li>
          <strong>Из Очереди</strong> — на странице{" "}
          <Link href="/docs/backlog">Очередь</Link> в bulk-плашке
          выделения или под фильтрами есть кнопка <strong>Whois</strong>{" "}
          (индиго). Она отправит выбранные/отфильтрованные домены на
          форму <code>/check/whois-history</code> с предзаполненным
          списком через <code>BACKLOG_HANDOFF_KEY</code>.
        </li>
        <li>
          <strong>Rerun из Задачи</strong> — обычная кнопка Rerun на
          странице Job создаёт новый Run с теми же доменами и
          настройками.
        </li>
      </ul>

      <h2>Стоимость</h2>
      <p>
        WhoisFreaks биллит <strong>за запрос</strong> в юнитах своего
        плана. Тариф зависит от подписки: базовый — 1 unit/request, на
        более дорогих планах — несколько unit-ов на запрос.
        Множитель настраивается в{" "}
        <Link href="/docs/settings">Настройках → Whois History →{" "}
        <code>units_per_request</code></Link>.
      </p>
      <p>
        Колонка cost на странице запуска показывает:
      </p>
      <ul>
        <li>
          <code>whois_fresh_calls</code> — сколько уникальных запросов
          было отправлено.
        </li>
        <li>
          <code>whois_units_per_request</code> — текущий множитель
          плана.
        </li>
        <li>
          <code>whois_units_billed</code> = fresh_calls × multiplier.
          Считается отдельно для аудита.
        </li>
      </ul>
      <p>
        Пилюля <strong>Whois units</strong> (индиго) рядом с AI cost и
        Ahrefs units. Tooltip показывает raw fresh_calls и multiplier —
        чтобы математика была проверяема.
      </p>
      <p>
        AI-токены судьи биллятся как обычно (любой AI-провайдер из
        Brain Settings). Подробности про AI-стоимость — в{" "}
        <Link href="/docs/ai">«ИИ: провайдеры, модели, стоимость»</Link>.
      </p>

      <h2>Настройки</h2>
      <p>
        Вкладка <em>Whois History</em> в{" "}
        <Link href="/docs/settings">Настройках</Link>:
      </p>
      <ul>
        <li>
          <strong>Provider</strong> — пока read-only (whoisfreaks).
          Меняется через config, не через UI.
        </li>
        <li>
          <strong>API key</strong> — write-only поле; зашифровано
          через Fernet в БД (<code>__api_key</code> suffix rule).
          Чтобы заменить ключ — введите новый и нажмите Save; пустой
          submit ключ не трогает. «Clear key» удаляет.
        </li>
        <li>
          <strong>max_records</strong> — сколько снапшотов брать (1-500,
          по умолчанию 100).
        </li>
        <li>
          <strong>coverage_gap_threshold_days</strong> — какие паузы в
          истории считать HARD-сигналом (1-365, по умолчанию 30).
        </li>
        <li>
          <strong>drop_confidence_threshold</strong> — порог,
          используемый только в логах и аналитике (0-1, по умолчанию
          0.8); саму классификацию в UI делает та же градация бэндов,
          что выше.
        </li>
        <li>
          <strong>units_per_request</strong> — множитель плана (1-100,
          по умолчанию 1).
        </li>
        <li>
          <strong>Rate limits</strong> — RPM + max_concurrent.
          WhoisFreaks жёстко лимитит даже на платных планах; не
          увеличивайте без необходимости.
        </li>
        <li>
          <strong>Test connection</strong> — кнопка для пробного
          запроса. Результат: зелёный (всё работает), амбер
          (key есть, но получили 429 / лимит), красный (auth fail или
          провайдер недоступен).
        </li>
      </ul>

      <h2>Per-domain view</h2>
      <p>
        Страница RunDomain для Whois-задачи (<code>data.job_kind ===
        &quot;whois_history&quot;</code>) рендерится не криптериальными
        табами, а одной выделенной секцией:
      </p>
      <ol>
        <li>
          <strong>AI verdict</strong> — большая плашка с цветовой
          рамкой по бэнду (см. выше). Показывает{" "}
          <em>dropped_confidence</em>, <em>transferred_confidence</em>,{" "}
          <em>summary</em>, <em>key_signals</em> и <em>recommendation</em>.
        </li>
        <li>
          <strong>Diff signals</strong> — структурный разбор HARD/SOFT
          сигналов с раскрывающимися деталями.
        </li>
        <li>
          <strong>Current state</strong> — последнее известное
          состояние WHOIS.
        </li>
        <li>
          <strong>Raw records</strong> — свёрнутая таблица всех
          снапшотов (newest-first). Открывается на запрос — это
          аудиторский лог, не основное чтение.
        </li>
      </ol>

      <h2>Ограничения и подводные камни</h2>
      <ul>
        <li>
          WhoisFreaks <strong>биллит каждый запрос</strong>, в том
          числе при повторных запусках. Не делайте rerun по тысяче
          доменов «на всякий случай» — сначала проверьте, нужны ли
          свежие данные.
        </li>
        <li>
          Whois-задача <strong>не комбинируется с другими критериями</strong>{" "}
          в одной Задаче — Job.kind дискриминирует, какой runner
          поднимается. Чтобы получить полную картину по домену,
          запустите Quality-Job, Whois-Job и Availability-Job отдельно;
          закрепите по критерию из каждого. Strana Базы сшивает
          получившиеся пины в одну строку с колонками{" "}
          <em>Ahrefs / Whois / Wayback</em>.
        </li>
        <li>
          Для свеже-зарегистрированных доменов или экзотических TLD
          провайдер может вернуть пустую историю. В этом случае Drop
          Sherlock не зовёт AI (экономия токенов), а пишет
          pre-canned-вердикт «No historical WHOIS records available».
        </li>
        <li>
          Промпт <code>whois_history_judge</code> уже отредактирован
          под цветовые бэнды (high drop → caution). Если вы измените
          его, помните, что rollup-пилюли на странице задачи
          по-прежнему мапятся по интервалам dropped_confidence —
          поэтому промпт должен возвращать число в этой шкале.
        </li>
      </ul>
    </div>
  );
}
