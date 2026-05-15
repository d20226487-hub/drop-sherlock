import Link from "next/link";

export const metadata = { title: "Availability — Drop Sherlock" };

export default function AvailabilityDoc() {
  return (
    <div className="docs-content">
      <h1>Availability (каскад проверки доступности)</h1>
      <p>
        Availability — это самостоятельный пилар (<code>Job.kind=
        &quot;availability&quot;</code>), который отвечает на простой
        вопрос «свободен ли этот домен прямо сейчас» через каскад
        бесплатных провайдеров. Wave 3 пилара задеплоилась 2026-05-15,
        повысив существующий каскад доступности из «sub-step Quality-
        запуска и кнопка-Recheck» до полноценного Job kind.
      </p>

      <div className="callout callout-info docs-content">
        <p>
          Важно: <strong>AI-судьи здесь нет</strong>. Каскад возвращает
          детерминированный label (<code>available</code> /{" "}
          <code>registered</code> / <code>unknown</code> /{" "}
          <code>error</code>) — нет смысла жечь токены на комментарий
          того, что и так однозначно. Это первое и самое заметное
          отличие от Quality + Whois History.
        </p>
      </div>

      <h2>Что делает каскад</h2>
      <p>
        Каскад идёт по провайдерам в заданном порядке (по умолчанию{" "}
        <code>dns → rdap → domainr → whois</code>) и
        останавливается на первом провайдере, который вернул
        терминальный ответ (<code>available</code> или{" "}
        <code>registered</code>):
      </p>
      <ul>
        <li>
          <strong>DNS</strong> — самый быстрый и бесплатный. Проверяет
          наличие NS-записей. NXDOMAIN — почти всегда{" "}
          <code>available</code>; наличие NS не равно{" "}
          <code>registered</code> (DNS-prober может быть введён в
          заблуждение, но это редкость).
        </li>
        <li>
          <strong>RDAP</strong> — бесплатный официальный протокол.
          Bootstrap из IANA + per-TLD discovery с хардкод-фоллбэком
          для <code>com</code> / <code>net</code> / <code>org</code>.
          Возвращает registrar + expires_on, если домен{" "}
          <code>registered</code>. Для exotic TLD (где нет RDAP-сервера —{" "}
          <code>.kz</code> и подобные) вернёт{" "}
          <code>unknown</code> с error_message.
        </li>
        <li>
          <strong>Domainr</strong> (опционально, RapidAPI Basic) —
          платная подстраховка для случаев, когда RDAP не отвечает.
          API key зашифрован Fernet-ом в БД. Включается тумблером в
          Настройках.
        </li>
        <li>
          <strong>WHOIS</strong> (TCP:43) — последний резерв. Хардкод-
          map gTLD → server + IANA <code>refer:</code> fallback для
          неизвестных TLD. Regex-парсинг ответов («no match» /{" "}
          <code>Registrar:</code> / <code>Registry Expiry Date:</code>).
        </li>
      </ul>
      <p>
        Каждый провайдер пишет одну строку в <code>availability_checks</code>{" "}
        — даже если он ответил <code>unknown</code> или <code>error</code>{" "}
        и каскад пошёл дальше. Это «трасса» каскада, которая видна на
        per-domain view (см. ниже) и в логе на странице Настроек.
      </p>

      <h2>Семантика статусов</h2>
      <ul>
        <li>
          <strong style={{ color: "#059669" }}>available</strong> —
          домен подтверждённо не зарегистрирован. Можно покупать.
        </li>
        <li>
          <strong>registered</strong> — домен подтверждённо
          зарегистрирован. Обычно с <em>registrar</em> и{" "}
          <em>expires_on</em>. Если <em>expires_on</em> близко —
          стоит ждать дропа; если далеко — пилюля «занят, но истечёт
          ещё не скоро».
        </li>
        <li>
          <strong style={{ color: "#d97706" }}>unknown</strong> —
          провайдер ответил, но не смог определить состояние (редко).
          Стоит запустить Recheck в другое время.
        </li>
        <li>
          <strong style={{ color: "#e11d48" }}>error</strong> — все
          опрошенные провайдеры провалились (timeout, 429, network,
          parse-failure). Скорее всего временная проблема —
          посмотрите на ошибочную плашку в Errors-page (категория{" "}
          <code>Availability</code>).
        </li>
      </ul>

      <h2>Как запустить</h2>
      <p>Три точки входа:</p>
      <ul>
        <li>
          <strong>Прямой сабмит</strong> — форма{" "}
          <code>/check/availability</code>. Вставьте домены, нажмите
          «Запустить» (без AI-провайдера). Создаётся{" "}
          <code>Job(kind=&quot;availability&quot;)</code>, диспатч
          уходит в <code>process_availability_run</code>.
        </li>
        <li>
          <strong>Из Очереди</strong> — на странице{" "}
          <Link href="/docs/backlog">Очереди</Link> в bulk-плашке
          выделения или под фильтрами есть кнопка{" "}
          <strong>Availability</strong> (голубая). Передача доменов
          через тот же <code>BACKLOG_HANDOFF_KEY</code>, что Quality и
          Whois — форма читает sessionStorage при монтировании.
        </li>
        <li>
          <strong>Recheck-кнопка</strong> на строке Database / Backlog
          — это <em>другой</em> путь: вызывает каскад напрямую без
          создания Job. С <em>use_cache=True</em>, чтобы кнопка была
          дешёвой. Используется для ad-hoc обновления конкретной
          строки.
        </li>
      </ul>

      <div className="callout callout-info docs-content">
        <p>
          <strong>use_cache=False в Job-форме (locked 2026-05-15):</strong>{" "}
          Availability-Job игнорирует кэш — каждый домен прогоняется
          через каскад заново. Логика «Job — это явный запрос свежего
          состояния»; cache-aware path остаётся за Recheck-кнопками.
          Если вам нужна экономия на дешёвых RDAP-запросах — используйте
          Recheck или измените default-TTL в Настройках, чтобы он не
          бил по другим точкам кода.
        </p>
      </div>

      <h2>Стоимость</h2>
      <p>
        DNS + RDAP + WHOIS:43 — <strong>бесплатно</strong>. Domainr —
        платный (RapidAPI Basic, тарифицируется по подписке RapidAPI).
        В Drop Sherlock нет per-Job cost-pill для Availability, потому
        что доминирующая часть каскада не стоит ничего. Если
        Domainr-провайдер включён, посмотрите на счёт через свой
        RapidAPI dashboard — Drop Sherlock не агрегирует его внутри.
      </p>

      <h2>Настройки</h2>
      <p>
        Вкладка <em>Availability</em> в{" "}
        <Link href="/docs/settings">Настройках</Link>:
      </p>
      <ul>
        <li>
          <strong>Cascade order</strong> — порядок провайдеров (drag-
          and-drop). По умолчанию{" "}
          <code>dns → rdap → domainr → whois</code>.
        </li>
        <li>
          <strong>Per-provider toggles</strong> — каждый провайдер
          можно выключить отдельно.
        </li>
        <li>
          <strong>RPS + max_concurrent</strong> — на провайдера. 10/s
          хардкод-cap независимо от введённого значения, как защита
          от случайных опечаток.
        </li>
        <li>
          <strong>Domainr API key</strong> — write-only, Fernet-
          зашифрован в БД (<code>__api_key</code> suffix). RapidAPI
          Basic tier.
        </li>
        <li>
          <strong>Skip-registered policy</strong> —{" "}
          <code>skip_horizon_days</code> (по умолчанию 90). Применяется
          только в <em>Quality</em>-запусках: если каскад вернул{" "}
          <code>registered</code> с <em>expires_on</em> дальше
          горизонта, Drop Sherlock пропустит Ahrefs/Wayback для этого
          домена (экономия юнитов Ahrefs). На Availability-Job эта
          политика не применяется — каскад тут и есть цель.
        </li>
        <li>
          <strong>Cache TTL</strong> — по умолчанию 24 часа. Применяется
          к Recheck-кнопкам и к каскаду внутри Quality-запусков; на
          Availability-Job игнорируется (use_cache=False).
        </li>
        <li>
          <strong>Retention</strong> — сколько хранить строки в{" "}
          <code>availability_checks</code> (для аналитики).
          APScheduler-задача чистит таблицу ежедневно.
        </li>
        <li>
          <strong>Monthly usage</strong> + recent log — счётчики
          вызовов и последние ошибки по провайдерам.
        </li>
      </ul>

      <h2>Per-domain view</h2>
      <p>
        Страница RunDomain для Availability-задачи (<code>data.job_kind ===
        &quot;availability&quot;</code>) рендерится двумя секциями:
      </p>
      <ol>
        <li>
          <strong>Verdict</strong> — финальный статус с цветовой
          пилюлей и тремя полями: <em>Resolved by</em> (какой
          провайдер дал ответ), <em>Registrar</em>, <em>Expires on</em>.
          Empty values рисуются «—».
        </li>
        <li>
          <strong>Cascade trace</strong> — таблица всех попыток в
          этом Run (newest-first). По одной строке на провайдера,
          который успел ответить. Колонки: Provider / Status / Latency /
          Registrar / Expires / Error / Checked at. Это аудитор —
          если каскад дал неожиданный <code>unknown</code> или{" "}
          <code>error</code>, тут видно, какой провайдер где упал и с
          каким error_message.
        </li>
      </ol>

      <h2>Колонка Availability в Базе и Очереди</h2>
      <p>
        Существовала и до Wave 3 — каскад писал в{" "}
        <code>availability_checks</code> при любом своём вызове, а
        колонка хидрировалась через{" "}
        <code>POST /availability/latest</code>. С Wave 3 колонка
        получила новый источник пинов: Availability-Job создаёт CR
        строки, которые Database-листинг подхватывает (если на
        домен есть либо пин, либо fallback на самый свежий
        availability-CR).
      </p>
      <p>
        Фильтр <strong>Availability</strong> на{" "}
        <Link href="/docs/database">Базе</Link> и{" "}
        <Link href="/docs/backlog">Очереди</Link> использует «семантику
        отображения» — для <code>available</code> /{" "}
        <code>registered</code> берётся самая свежая <em>терминальная</em>{" "}
        запись (как и колонка), для <code>unknown</code> /{" "}
        <code>error</code> — самая свежая запись при условии, что
        терминальной не было вовсе. Это предотвращает фальшивые
        misses, когда более поздний RDAP-таймаут затмевал более
        ранний успешный DNS-ответ.
      </p>

      <h2>Ограничения и подводные камни</h2>
      <ul>
        <li>
          DNS-проверка может дать <code>available</code> на домен,
          который технически зарегистрирован, но не имеет NS-записей
          (parked-without-DNS). Редкий, но возможный случай. RDAP
          проверит точнее — поэтому DNS никогда не должен быть
          единственным провайдером.
        </li>
        <li>
          RDAP-сервер для конкретного TLD может быть offline — каскад
          корректно идёт дальше по цепочке. Если все провайдеры
          ответили <code>unknown</code>/<code>error</code>, в трассе
          будет видно почему.
        </li>
        <li>
          Domainr free-tier на RapidAPI быстро упирается в лимиты;
          для частых проверок нужен платный план либо отключить
          его и работать без подстраховки.
        </li>
        <li>
          Availability-Job <strong>не закроет недостаток данных</strong>{" "}
          для drop-hunting сам по себе — он отвечает только на «когда
          истекает». Чтобы понять качество домена, всё равно нужен
          Quality или Whois History.
        </li>
      </ul>
    </div>
  );
}
