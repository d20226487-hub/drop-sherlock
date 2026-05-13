import Link from "next/link";

export const metadata = { title: "Закрепление — Drop Sherlock" };

export default function PinningDoc() {
  return (
    <div className="docs-content">
      <h1>Закрепление (Pinning)</h1>
      <p>
        В Drop Sherlock несколько разных пинов. Эта статья — карта того,
        что какой пин делает. Главный, добавленный 2026-05-12 —
        per-(job, criterion); legacy «Pin entire run» удалён в этой же
        итерации (его заменила кнопка «Pin all populated» в панели
        per-criterion).
      </p>

      <h2>Три уровня</h2>
      <table>
        <thead>
          <tr>
            <th>Уровень</th>
            <th>Что закрепляет</th>
            <th>На что влияет</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>RunDomain.is_pinned</strong>
            </td>
            <td>
              Один конкретный RunDomain (домен × запуск)
            </td>
            <td>
              <Link href="/docs/database">Базу</Link>: какой RunDomain
              выводится как канонический для домена
            </td>
          </tr>
          <tr>
            <td>
              <strong>Run.is_pinned</strong>
            </td>
            <td>Один конкретный Run (один на Job)</td>
            <td>
              <Link href="/docs/jobs">Страницу задачи</Link>: какой запуск
              даёт цифры для сводных плашек
            </td>
          </tr>
          <tr>
            <td>
              <strong>job_criterion_pin</strong>
            </td>
            <td>Один Run на каждый критерий внутри Job</td>
            <td>
              <Link href="/docs/database">Базу</Link>: на критерийном
              уровне — какой Run даёт данные для каждого критерия
            </td>
          </tr>
        </tbody>
      </table>

      <h2>RunDomain pin (per-domain)</h2>
      <p>
        Один домен может анализироваться много раз (разные задачи, reruns,
        переоценки). Без пина Drop Sherlock не знал бы, какой из этих
        RunDomain считать «истиной» в Базе. Закреплённый RunDomain — это
        ваш явный ответ: «вот этот вариант, его и показывай в строке
        Базы».
      </p>
      <p>Инвариант: <em>не больше одного пина на домен</em>.</p>
      <p>Где закрепляется:</p>
      <ul>
        <li>
          В <Link href="/docs/database">Базе</Link>, колонка{" "}
          <strong>Pin</strong> — селектор со списком всех RunDomain того же
          домена.
        </li>
        <li>
          В <Link href="/docs/domain">странице домена</Link>, кнопка{" "}
          <strong>«Pin this RunDomain as canonical»</strong>.
        </li>
        <li>
          В <Link href="/docs/run">странице запуска</Link>, колонка{" "}
          <strong>Pin</strong> в каждой строке.
        </li>
      </ul>

      <h2>Run pin (per-job)</h2>
      <p>
        У одной задачи (Job) может быть несколько Runs. Какой из них
        представляет «состояние» задачи в сводных плашках? Без пина — самый
        свежий (max(Run.id)). С пином — закреплённый.
      </p>
      <p>
        Зачем нужно: вы сделали полный прогон 200 доменов, а затем
        частичный rerun только 10 доменов под A/B-тест промпта. По
        умолчанию плашки покажут статистику по этим 10 доменам (последний
        run) — что вводит в заблуждение. Закрепляете полный 200-доменный
        run — плашки возвращаются к полной картине.
      </p>
      <p>Инварианты:</p>
      <ul>
        <li>Не больше одного пина на задачу.</li>
        <li>Закрепить можно только <code>done</code>-запуск.</li>
        <li>
          Закрепление другого запуска <em>заменяет</em> старый пин (без
          подтверждения — это «переключатель»).
        </li>
      </ul>
      <p>Где закрепляется:</p>
      <ul>
        <li>
          На <Link href="/docs/jobs">странице задачи</Link>, в строке
          каждого Run — кнопка <strong>«Pin»</strong> (для{" "}
          <code>done</code>; иначе кнопка скрыта).
        </li>
      </ul>

      <h2>Пины по критериям (per-(job, criterion))</h2>
      <p>
        Добавлено 2026-05-12. Самый новый и самый гибкий уровень пина —
        предназначен для итеративного каскада: сначала запустили Wayback
        (дёшево), потом по выжившим запустили Ahrefs (дорого), и хотите,
        чтобы База собрала вердикт из обоих запусков.
      </p>
      <p>
        Один пин — это запись «для этой задачи, критерий C берётся из
        Run R». В пределах одной задачи каждый критерий{" "}
        (<code>backlinks</code> / <code>refdomains</code> /{" "}
        <code>anchors</code> / <code>keywords</code> /{" "}
        <code>wayback</code> / <code>wayback_classify</code>) может
        указывать на свой собственный Run. Страница Базы для каждого
        домена аккуратно сшивает по-критериально пинённые данные в одну
        строку.
      </p>
      <p>Инварианты:</p>
      <ul>
        <li>Не больше одного пина на пару (задача, критерий).</li>
        <li>
          Закрепить можно только <code>done</code>-запуск (тот же
          принцип, что у Run.is_pinned).
        </li>
        <li>
          Run должен принадлежать той же задаче, что и пин (проверяется на
          бэкенде).
        </li>
        <li>
          Если у пин-Run нет CR-данных по своему критерию для конкретного
          домена — ячейка остаётся пустой (никакого fallback на «свежий»
          Run).
        </li>
      </ul>
      <p>Где закрепляется:</p>
      <ul>
        <li>
          На <Link href="/docs/run">странице запуска</Link>, секция{" "}
          <strong>Per-criterion pins</strong> — отдельная плашка на
          каждый критерий, который запуск посчитал. Клик: закрепить на
          этот Run / открепить.
        </li>
        <li>
          Кнопка <strong>«Pin all populated»</strong> там же —
          закрепляет в этот Run все критерии, по которым у него есть
          данные, одним кликом.
        </li>
      </ul>

      <h3>Частичный финал</h3>
      <p>
        Если в задаче для домена закреплено не всё (например, только W и
        K), Страница Базы покажет плашку <strong>«partial»</strong> на
        FinalBanner с подсказкой «Partial — based on W, K. Pin remaining
        criteria from their Runs to get a full verdict». Это
        ожидаемое поведение, а не ошибка — пока вы не пинете
        остальные критерии, итоговый балл не вычисляется.
      </p>

      <h3>Совместимость со старыми пинами</h3>
      <p>
        При первом запуске после обновления уже существующие{" "}
        <code>Run.is_pinned</code> и <code>RunDomain.is_pinned</code>{" "}
        автоматически разворачиваются в пины по критериям —
        по одной строке на каждый критерий, по которому у пин-Run есть
        данные. Если пин-Run не содержал какого-то критерия — этот
        критерий останется без пина, и Страница Базы покажет пустую
        ячейку (это принятый при выпуске «no fallback»-режим). Чтобы
        вернуть данные — закрепите критерий из соответствующего Run.
      </p>
      <p>
        Кнопка «Pin» в строке запуска на Job-странице по-прежнему живёт
        — она дополнительно прописывает пины по критериям. Кнопка «Pin
        entire run» удалена; её заменил «Pin all populated» в панели
        Per-criterion pins на странице запуска.
      </p>

      <h2>Сводная шпаргалка</h2>
      <table>
        <thead>
          <tr>
            <th>Хочу...</th>
            <th>Какой пин</th>
            <th>Где</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Чтобы конкретный анализ домена был источником в Базе</td>
            <td>RunDomain.is_pinned</td>
            <td>Database → колонка Pin / Domain page → Pin</td>
          </tr>
          <tr>
            <td>Чтобы плашки задачи считались по конкретному прогону</td>
            <td>Run.is_pinned</td>
            <td>Job page → строка запуска → Pin</td>
          </tr>
          <tr>
            <td>Зафиксировать критерий на конкретный Run в задаче</td>
            <td>job_criterion_pin</td>
            <td>Run page → Per-criterion pins → клик по критерию</td>
          </tr>
          <tr>
            <td>Закрепить все критерии этого запуска одним кликом</td>
            <td>job_criterion_pin (массово)</td>
            <td>Run page → Per-criterion pins → «Pin all populated»</td>
          </tr>
          <tr>
            <td>Откатить — Database вернётся к latest</td>
            <td>Unpin RunDomain</td>
            <td>Database → колонка Pin → Unpin</td>
          </tr>
          <tr>
            <td>Откатить — плашки задачи вернутся к latest</td>
            <td>Unpin Run</td>
            <td>Job page → строка запуска → Unpin</td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info docs-content">
        <p>
          <strong>На что обратить внимание:</strong> «Pin all populated»
          в панели Per-criterion pins закрепит на этот Run каждый
          критерий, по которому в нём есть данные — включая
          информационные (Wayback, wayback_classify) с весом 0. Если
          этого не нужно, фиксируйте критерии по отдельности.
        </p>
      </div>
    </div>
  );
}
