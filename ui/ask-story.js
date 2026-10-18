/** Manual research panel. All model and stored text is rendered as text, never HTML. */
import { askStory, STORY_LIMITS } from '../core/story-research.js';
import { completeStoryAnswer } from '../core/story-answer-llm.js';

export function openAskStoryPanel(settings, saveSettings) {
    const previous = document.getElementById('VectFox_ask_story_panel');
    if (previous) { previous.scrollIntoView?.({ block: 'nearest' }); return; }
    const host = document.createElement('section');
    host.id = 'VectFox_ask_story_panel';
    host.className = 'vectfox-ask-story';
    const element = (tag, text, parent = host) => {
        const node = document.createElement(tag);
        if (text != null) node.textContent = text;
        parent.append(node);
        return node;
    };
    element('h3', 'Ask the Story');
    const label = element('label');
    const enabled = element('input', null, label);
    enabled.type = 'checkbox';
    enabled.checked = settings.ask_story_enabled === true;
    label.append(document.createTextNode(' Enable manual Ask requests (off by default)'));
    const scope = element('p');
    const limits = element('small', `One answer call; no planning or retries. Up to ${STORY_LIMITS.candidates} candidates, ${STORY_LIMITS.evidence} evidence records, ${STORY_LIMITS.evidenceChars} evidence characters; 2048 output tokens. No lorebook writes or context injection.`);
    limits.style.display = 'block';
    const questionLabel = element('label', 'Research question');
    const question = element('textarea');
    question.id = 'VectFox_story_question';
    questionLabel.htmlFor = question.id;
    question.maxLength = STORY_LIMITS.questionChars;
    question.rows = 3;
    question.className = 'vectfox-input';
    question.placeholder = 'How did Alex meet Ranger?';
    const actions = element('div');
    const button = (text, action) => {
        const node = element('button', text, actions);
        node.type = 'button';
        node.className = 'menu_button';
        node.addEventListener('click', action);
        return node;
    };
    const status = element('p');
    status.setAttribute('role', 'status');
    const output = element('div');
    let controller = null, answer = null, activeToken = null, closed = false, operation = 0;
    const api = () => window.VectFoxAPI;
    const refresh = () => {
        const state = api()?.getStatus();
        const valid = state?.ready && (!activeToken || activeToken === state.scope_token);
        if (!valid && (controller || answer)) {
            controller?.abort();
            answer = null;
            output.replaceChildren();
            status.textContent = 'Story scope changed or became unavailable. Ask again.';
        }
        scope.textContent = `Model: ${settings.chat_model || '(not configured)'} (${settings.chat_provider || 'openrouter'}). Scope: current chat; collections: ${state?.effective_collections?.map(c => c.collectionId).join(', ') || '(none)'}. VectFox: ${state?.state || 'unavailable'}.`;
        ask.disabled = !enabled.checked || !!controller || !state?.ready;
        cancel.disabled = !controller;
        copy.disabled = !answer;
    };
    const render = result => {
        output.replaceChildren();
        element('strong', result.status === 'no_evidence' ? 'No relevant evidence' : result.status === 'partial' ? 'Partial answer' : 'Answer', output);
        if (result.gap) element('p', result.gap, output);
        const coverage = result.coverage;
        element('p', `Coverage: ${coverage.returned_count} retrieved, ${coverage.evidence_count} shown to model. ${coverage.search_policy}. ${coverage.sampled ? 'History sampled. ' : ''}${coverage.truncated ? 'Search/evidence truncated. ' : ''}${coverage.partial ? 'Some records unavailable or sources unknown. ' : ''}${coverage.sources_unavailable ? 'Some originals unavailable or unverified. ' : ''}${result.calls} generation call(s).`, output);
        element('small', 'Citations identify supplied evidence, not proof that the model interpreted it correctly. Inspect the summaries below.', output);
        for (const claim of result.claims) {
            const block = element('div', null, output);
            element('p', claim.sentence, block);
            for (const ref of claim.event_refs) {
                const event = result.evidence.find(item => item.event_ref === ref);
                const details = element('details', null, block);
                element('summary', `${event.event_id} · ${event.source_chat_id || 'unknown chat'} · source ${event.source_window_start ?? '?'}`, details);
                element('p', `Stored summary: ${event.summary || ''}`, details);
                if (event.DateTime) element('p', `Stored story date (DateTime): ${event.DateTime}`, details);
                if (event.scene_time) element('p', `Stored scene time: ${event.scene_time}`, details);
                if (event.cause) element('p', `Cause: ${event.cause}`, details);
                if (event.result) element('p', `Result: ${event.result}`, details);
                element('small', ref, details);
                for (const sourceRef of event.source_refs || []) {
                    const source = result.sources.find(item => item.ref === sourceRef.ref);
                    if (source?.status === 'verified' && source.message) {
                        const original = element('details', null, details);
                        element('summary', source.recovered_ils ? 'Inspect recovered ILS original' : 'Inspect verified original message', original);
                        element('pre', `${source.message.name}: ${source.message.mes}`, original);
                    } else element('p', `Original unavailable: ${source?.status || 'unresolved'}${source?.reason ? ` (${source.reason})` : ''}`, details);
                }
            }
        }
    };
    const ask = button('Ask', async () => {
        controller = new AbortController();
        const request = controller;
        const run = ++operation;
        const config = { ...settings };
        const researchQuestion = question.value;
        activeToken = api()?.getStatus().scope_token;
        answer = null;
        output.replaceChildren();
        status.textContent = 'Researching stored events…';
        refresh();
        try {
            const result = await askStory({ api: api(), question: researchQuestion,
                complete: (prompt, signal) => completeStoryAnswer(prompt, config, signal), signal: request.signal });
            if (closed || run !== operation) return;
            request.signal.throwIfAborted();
            if (!enabled.checked || api().getStatus().scope_token !== result.scope_token) throw new Error('Story scope changed. Ask again.');
            answer = { ...result, question: researchQuestion };
            render(result);
            status.textContent = 'Research complete.';
        } catch (error) {
            if (!closed && run === operation) status.textContent = request.signal.aborted ? 'Request cancelled; no answer accepted.' : `Research failed: ${error.message}`;
        } finally {
            if (!closed && run === operation) { controller = null; refresh(); }
        }
    });
    const cancel = button('Cancel', () => { controller?.abort(); status.textContent = 'Cancelling request…'; });
    const copy = button('Copy', async () => {
        refresh();
        if (!answer) return;
        try {
            await navigator.clipboard.writeText([answer.question, ...answer.claims.map(c => `${c.sentence} [${c.event_refs.join(', ')}]`),
                answer.gap, `Coverage: ${JSON.stringify(answer.coverage)}`].filter(Boolean).join('\n\n'));
            if (!closed) status.textContent = 'Copied answer, citations, and coverage.';
        } catch { if (!closed) status.textContent = 'Clipboard unavailable.'; }
    });
    button('Close', () => { closed = true; controller?.abort(); clearInterval(poll); host.remove(); });
    enabled.addEventListener('change', () => {
        settings.ask_story_enabled = enabled.checked;
        saveSettings();
        if (!enabled.checked) { controller?.abort(); answer = null; output.replaceChildren(); }
        refresh();
    });
    const poll = setInterval(() => {
        if (!host.isConnected) { closed = true; controller?.abort(); clearInterval(poll); return; }
        refresh();
    }, 500);
    document.getElementById('VectFox_ask_story').closest('.vectfox-card')?.append(host);
    if (!host.isConnected) document.getElementById('VectFox_ask_story').parentElement.after(host);
    refresh();
    host.scrollIntoView?.({ block: 'nearest' });
    question.focus();
}