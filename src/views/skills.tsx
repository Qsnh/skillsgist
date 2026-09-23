import { Form } from "../csrf";
import { ClassMark, CodeBlock, Layout } from "./layout";
import type { SkillRow, UserRow, VersionRow } from "../db/queries";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function IndexPage(props: {
  user: UserRow | null;
  skills: Array<SkillRow & { author: string }>;
  q: string;
  origin: string;
}) {
  const count = props.skills.length;
  const extent = `${count} ${count === 1 ? "entry" : "entries"}`;
  return (
    <Layout title="Skills" user={props.user}>
      <section class="band band--bleed">
        <div class="band__head">
          <span class="legend">Installation</span>
        </div>
        <CodeBlock>
          npx skills add {props.user ? `${props.origin}/i/${props.user.install_key}` : props.origin}
        </CodeBlock>
      </section>

      <section class="band band--bleed">
        <form method="get" action="/">
          <div class="band__head">
            <label for="q" class="legend band__legend--live">Search · name / description / body</label>
          </div>
          <div class="channel">
            <input
              id="q"
              name="q"
              value={props.q}
              placeholder="Search this catalogue"
              class="channel__input"
            />
            <button type="submit" class="channel__submit"><span class="legend">Search</span></button>
          </div>
        </form>
      </section>

      <div class="band band--head">
        <div class="band__head band__head--flush">
          <h1 class="legend">{props.q ? `Matching “${props.q}”` : "Catalogue"}</h1>
          <span class="legend">{extent}</span>
        </div>
      </div>

      {count === 0 ? (
        <div class="void">
          <p class="void__name">{props.q ? "No entry matches" : "This catalogue is empty"}</p>
          <p class="void__line">
            {props.q ? (
              <>
                Nothing here is named, described, or written like “{props.q}”.{" "}
                <a href="/">Clear the search</a> to see the whole catalogue.
              </>
            ) : props.user ? (
              <>
                Nothing has been published to this instance yet.{" "}
                <a href="/new">Publish the first skill</a>.
              </>
            ) : (
              <>
                No skill here is public. <a href="/login">Sign in</a> to see private entries.
              </>
            )}
          </p>
        </div>
      ) : (
        <ul class="entries">
          {props.skills.map((s) => (
            <li class={`entry entry--${s.visibility}`}>
              <h2 class="entry__heading">
                <a href={`/s/${s.slug}`} class="entry__name">{s.slug}</a>
              </h2>
              <p class="entry__spec">{s.description}</p>
              <div class="entry__rail">
                <ClassMark visibility={s.visibility} />
                <dl class="entry__fields">
                  <dt class="legend">Version</dt>
                  <dd>v{s.latest_version}</dd>
                  <dt class="legend">Author</dt>
                  <dd>{s.author}</dd>
                  <dt class="legend">Updated</dt>
                  <dd>{new Date(s.updated_at).toISOString().slice(0, 10)}</dd>
                </dl>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export function SkillPage(props: {
  user: UserRow | null;
  skill: SkillRow & { author: string };
  version: VersionRow;
  origin: string;
  canManage: boolean;
}) {
  const slug = props.skill.slug;
  const superseded = props.version.version !== props.skill.latest_version;
  const base = props.user ? `${props.origin}/i/${props.user.install_key}` : props.origin;
  const dispenseUrl = `${base}/.well-known/agent-skills/${slug}`;
  return (
    <Layout title={slug} user={props.user}>
      <div class="band band--entry">
        <div class={`entry entry--${props.skill.visibility}`}>
          <h1 class="entry__heading lead">{slug}</h1>
          <p class="entry__spec">{props.version.description}</p>
          <div class="entry__rail">
            <ClassMark visibility={props.skill.visibility} />
            <dl class="entry__fields">
              <dt class="legend">Version</dt>
              <dd>v{props.version.version}</dd>
              <dt class="legend">Author</dt>
              <dd>{props.skill.author}</dd>
              <dt class="legend">Published</dt>
              <dd>{day(props.version.created_at)}</dd>
            </dl>
          </div>
        </div>
      </div>

      {superseded ? (
        <p class="notice">
          <span class="legend">Superseded version</span>{" "}
          <a href={`/s/${slug}`}>v{props.skill.latest_version} is the current version</a>
        </p>
      ) : null}

      <section class="band band--bleed">
        <div class="band__head">
          <span class="legend">Installation</span>
        </div>
        <CodeBlock>npx skills add {dispenseUrl}</CodeBlock>
      </section>

      <div class="cells">
        <a
          href={superseded ? `/s/${slug}/v/${props.version.version}/download` : `/s/${slug}/download`}
          class="field-cell"
        >
          <span class="legend">Download zip{superseded ? ` · v${props.version.version}` : ""}</span>
        </a>
        {props.canManage ? (
          <>
            {superseded ? null : (
              <>
                <a href={`/s/${slug}/edit`} class="field-cell"><span class="legend">Edit SKILL.md</span></a>
                <a href={`/s/${slug}/upload`} class="field-cell"><span class="legend">Upload an archive</span></a>
              </>
            )}
            <Form action={`/s/${slug}/visibility`}>
              <button type="submit" class="field-cell">
                <span class="legend">
                  {props.skill.visibility === "public" ? "Make private" : "Make public"}
                </span>
              </button>
            </Form>
            <Form action={`/s/${slug}/delete`}>
              <button type="submit" class="field-cell field-cell--danger">
                <span class="legend">Delete</span>
              </button>
            </Form>
          </>
        ) : null}
      </div>

      <section class="band">
        <div class="band__head">
          <h2 class="legend">SKILL.md</h2>
        </div>
        <article class="skill-doc" dangerouslySetInnerHTML={{ __html: props.version.html }} />
      </section>
    </Layout>
  );
}
