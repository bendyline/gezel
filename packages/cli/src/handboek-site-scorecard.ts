import {
  MODEL_TIER_ORDER,
  SCORECARD_DATA_ATTRS,
  SCORECARD_QUERY_PARAMS,
  SCORECARD_ROUND_ALL,
  SCORECARD_ROUND_LATEST,
} from '@bendyline/gezel';

/**
 * The scorecard filter, shipped with the static Handboek export as
 * `<out>/assets/scorecard.js` and linked only from pages that contain a
 * scorecard.
 *
 * It is a progressive enhancement over markup that is already complete and
 * already correct: the page ships every recorded round in date order, and
 * this script narrows it to the one a reader asked for. Nothing here
 * computes a score, ranks a model, or decides what may be published — that
 * all happened in `renderScorecardFilterHtml`, where it can be tested. A
 * hidden round is hidden, never rewritten.
 *
 * The attribute and query-parameter names come from
 * `@bendyline/gezel`'s scorecard filter vocabulary, interpolated below, so
 * this script and the renderer cannot drift into reading a stamp the other
 * side stopped writing.
 *
 * Plain ES5-flavored browser JavaScript on purpose: it is served as a bare
 * `<script>` with no build step behind it.
 */

const ATTRS = SCORECARD_DATA_ATTRS;
const PARAMS = SCORECARD_QUERY_PARAMS;

export const SCORECARD_FILTER_JS = `(function () {
  'use strict';

  var ATTR = ${JSON.stringify(ATTRS)};
  var PARAM = ${JSON.stringify(PARAMS)};
  var ROUND_LATEST = ${JSON.stringify(SCORECARD_ROUND_LATEST)};
  var ROUND_ALL = ${JSON.stringify(SCORECARD_ROUND_ALL)};
  var TIER_ORDER = ${JSON.stringify(MODEL_TIER_ORDER)};

  var ANY = '';

  function attr(el, name) {
    var value = el.getAttribute(name);
    return value === null ? '' : value;
  }

  function tokens(el, name) {
    var raw = attr(el, name).trim();
    return raw ? raw.split(/\\s+/) : [];
  }

  function unique(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && !Object.prototype.hasOwnProperty.call(seen, list[i])) {
        seen[list[i]] = true;
        out.push(list[i]);
      }
    }
    return out;
  }

  function collect(root) {
    var nodes = root.querySelectorAll('[' + ATTR.round + ']');
    var rounds = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      rounds.push({
        el: el,
        id: attr(el, ATTR.round),
        label: attr(el, ATTR.roundLabel) || attr(el, ATTR.date),
        date: attr(el, ATTR.date),
        hardware: attr(el, ATTR.hardware),
        hardwareLabel: attr(el, ATTR.hardwareLabel) || attr(el, ATTR.hardware),
        models: tokens(el, ATTR.models),
        tiers: tokens(el, ATTR.tiers),
        latest: el.hasAttribute(ATTR.latest)
      });
    }
    return rounds;
  }

  function facets(rounds) {
    var hardware = [];
    var hardwareSeen = {};
    var models = [];
    var tiers = [];
    for (var i = 0; i < rounds.length; i++) {
      var round = rounds[i];
      if (round.hardware && !Object.prototype.hasOwnProperty.call(hardwareSeen, round.hardware)) {
        hardwareSeen[round.hardware] = true;
        hardware.push({ value: round.hardware, label: round.hardwareLabel });
      }
      models = models.concat(round.models);
      tiers = tiers.concat(round.tiers);
    }
    models = unique(models).sort();
    tiers = unique(tiers).sort(function (a, b) {
      return TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b);
    });
    return { hardware: hardware, models: models, tiers: tiers };
  }

  /* ── state ──────────────────────────────────────────────────────── */

  function readState() {
    var params = new URLSearchParams(window.location.search);
    return {
      round: params.get(PARAM.round) || ANY,
      date: params.get(PARAM.date) || ANY,
      hardware: params.get(PARAM.hardware) || ANY,
      model: params.get(PARAM.model) || ANY,
      modelClass: params.get(PARAM.modelClass) || ANY
    };
  }

  function narrowed(state) {
    return !!(state.hardware || state.model || state.modelClass);
  }

  /*
   * A pinned round wins; otherwise the default depends on whether the
   * reader has narrowed anything. Asking for one model with the page still
   * pinned to the latest round would answer "no results" whenever that
   * round did not measure it — so any narrowing opens the history.
   */
  function scopeFor(state, rounds) {
    if (state.round === ROUND_ALL) return rounds;
    if (state.round === ROUND_LATEST) return latest(rounds);
    if (state.round) {
      return rounds.filter(function (round) {
        return round.id === state.round;
      });
    }
    if (state.date) {
      return rounds.filter(function (round) {
        return round.date === state.date;
      });
    }
    return narrowed(state) ? rounds : latest(rounds);
  }

  function latest(rounds) {
    var flagged = rounds.filter(function (round) {
      return round.latest;
    });
    if (flagged.length > 0) return flagged;
    return rounds.length > 0 ? [rounds[0]] : [];
  }

  /* Which option the round picker should show for the current state. */
  function roundSelection(state, rounds) {
    if (state.round) return state.round;
    if (state.date) {
      var onDate = rounds.filter(function (round) {
        return round.date === state.date;
      });
      if (onDate.length === 1) return onDate[0].id;
      return onDate.length > 0 ? ROUND_ALL : ROUND_LATEST;
    }
    return narrowed(state) ? ROUND_ALL : ROUND_LATEST;
  }

  /*
   * The shortest link that reproduces exactly what is on screen.
   *
   * Two rules earn their complexity. A round of ROUND_LATEST or ROUND_ALL
   * is written only when it is NOT what scopeFor would have defaulted to,
   * because the default flips once the reader narrows something — omitting
   * it on the wrong side of that flip hands out a link that opens a
   * different page than the one that was shared. And a pinned round is
   * written as its date whenever that date belongs to one sweep, because
   * ?date=2026-08-22 is what a person would rather paste into a message;
   * dates are not unique, so the run id is still written when one date
   * carries two.
   */
  function writeState(state, rounds) {
    var params = new URLSearchParams(window.location.search);
    params.delete(PARAM.round);
    params.delete(PARAM.date);
    params.delete(PARAM.hardware);
    params.delete(PARAM.model);
    params.delete(PARAM.modelClass);
    var defaultRound = narrowed(state) ? ROUND_ALL : ROUND_LATEST;
    if (state.round === ROUND_ALL || state.round === ROUND_LATEST) {
      if (state.round !== defaultRound) params.set(PARAM.round, state.round);
    } else if (state.round) {
      var pinned = rounds.filter(function (round) {
        return round.id === state.round;
      })[0];
      var sharesDate = pinned
        ? rounds.filter(function (round) {
            return round.date === pinned.date;
          }).length > 1
        : true;
      if (pinned && !sharesDate) params.set(PARAM.date, pinned.date);
      else params.set(PARAM.round, state.round);
    } else if (state.date) {
      params.set(PARAM.date, state.date);
    }
    if (state.hardware) params.set(PARAM.hardware, state.hardware);
    if (state.model) params.set(PARAM.model, state.model);
    if (state.modelClass) params.set(PARAM.modelClass, state.modelClass);
    var query = params.toString();
    var url = window.location.pathname + (query ? '?' + query : '') + window.location.hash;
    window.history.replaceState(null, '', url);
  }

  /* ── controls ───────────────────────────────────────────────────── */

  function option(value, label) {
    var el = document.createElement('option');
    el.value = value;
    el.textContent = label;
    return el;
  }

  function field(id, labelText, options) {
    var wrap = document.createElement('label');
    wrap.className = 'hb-scorecard-field';
    var caption = document.createElement('span');
    caption.className = 'hb-scorecard-field-label';
    caption.textContent = labelText;
    var select = document.createElement('select');
    select.className = 'hb-scorecard-select';
    select.id = id;
    for (var i = 0; i < options.length; i++) {
      select.appendChild(option(options[i].value, options[i].label));
    }
    wrap.appendChild(caption);
    wrap.appendChild(select);
    return { wrap: wrap, select: select };
  }

  function enhance(root) {
    var mount = root.querySelector('[' + ATTR.controls + ']');
    var rounds = collect(root);
    if (!mount || rounds.length === 0) return;
    var facet = facets(rounds);

    var roundOptions = [
      { value: ROUND_LATEST, label: 'Latest round' },
      { value: ROUND_ALL, label: 'All rounds' }
    ];
    for (var i = 0; i < rounds.length; i++) {
      roundOptions.push({ value: rounds[i].id, label: rounds[i].label });
    }
    var hardwareOptions = [{ value: ANY, label: 'Any hardware' }];
    for (var h = 0; h < facet.hardware.length; h++) {
      hardwareOptions.push({ value: facet.hardware[h].value, label: facet.hardware[h].label });
    }
    var modelOptions = [{ value: ANY, label: 'Any model' }];
    for (var m = 0; m < facet.models.length; m++) {
      modelOptions.push({ value: facet.models[m], label: facet.models[m] });
    }
    var classOptions = [{ value: ANY, label: 'Any class' }];
    for (var c = 0; c < facet.tiers.length; c++) {
      classOptions.push({ value: facet.tiers[c], label: facet.tiers[c] });
    }

    var bar = document.createElement('div');
    bar.className = 'hb-scorecard-controlbar';
    var hardware = field('hb-scorecard-hardware', 'Hardware', hardwareOptions);
    var model = field('hb-scorecard-model', 'Model', modelOptions);
    var modelClass = field('hb-scorecard-class', 'Model class', classOptions);
    var round = field('hb-scorecard-round', 'Test round', roundOptions);
    bar.appendChild(hardware.wrap);
    bar.appendChild(model.wrap);
    bar.appendChild(modelClass.wrap);
    bar.appendChild(round.wrap);

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'hb-scorecard-reset';
    reset.textContent = 'Reset to latest';

    var status = document.createElement('p');
    status.className = 'hb-scorecard-status';
    status.setAttribute('role', 'status');

    // Written by the script rather than into the article, because it is only
    // true where the controls exist: the same prose is read in the app, where
    // this page is a fixed stack of rounds with no address bar behind it.
    var help = document.createElement('p');
    help.className = 'hb-scorecard-help';
    help.textContent =
      'Pick a machine, a model, or a round. Your choice goes into the address bar, so a link you copy opens the same view.';

    mount.appendChild(bar);
    mount.appendChild(status);
    mount.appendChild(help);
    bar.appendChild(reset);

    var state = readState();

    function render() {
      var scope = scopeFor(state, rounds);
      var inScope = {};
      for (var s = 0; s < scope.length; s++) inScope[scope[s].id] = true;

      var shown = 0;
      for (var r = 0; r < rounds.length; r++) {
        var entry = rounds[r];
        var visible =
          !!inScope[entry.id] &&
          (!state.hardware || entry.hardware === state.hardware) &&
          rowsMatch(entry.el);
        entry.el.hidden = !visible;
        if (visible) shown++;
      }

      hardware.select.value = state.hardware;
      model.select.value = state.model;
      modelClass.select.value = state.modelClass;
      round.select.value = roundSelection(state, rounds);
      reset.hidden = !state.hardware && !state.model && !state.modelClass && !state.round && !state.date;

      status.textContent = shown === 0
        ? 'No test rounds match these filters.'
        : 'Showing ' + shown + ' of ' + rounds.length + ' test ' + (rounds.length === 1 ? 'round' : 'rounds') + '.';
      writeState(state, rounds);
    }

    /*
     * Rows and whole suite tables hide together with what they contain: a
     * suite whose every row was filtered out would otherwise leave a
     * heading over an empty table, which reads as "measured nothing" rather
     * than "not what you asked for". Returns whether the round kept
     * anything at all.
     */
    function rowsMatch(roundEl) {
      var suites = roundEl.querySelectorAll('[' + ATTR.suite + ']');
      var kept = 0;
      for (var i = 0; i < suites.length; i++) {
        var rows = suites[i].querySelectorAll('[' + ATTR.model + ']');
        var visibleRows = 0;
        for (var j = 0; j < rows.length; j++) {
          var row = rows[j];
          var ok =
            (!state.model || attr(row, ATTR.model) === state.model) &&
            (!state.modelClass || attr(row, ATTR.tier) === state.modelClass);
          row.hidden = !ok;
          if (ok) visibleRows++;
        }
        suites[i].hidden = visibleRows === 0;
        if (visibleRows > 0) kept++;
      }
      return kept > 0;
    }

    function onNarrow(key, value) {
      state[key] = value;
      // Opening a narrower question on the latest round alone would answer
      // it with whatever that one sweep happened to cover.
      if (!state.round && !state.date && narrowed(state)) state.round = ROUND_ALL;
      render();
    }

    hardware.select.addEventListener('change', function () {
      onNarrow('hardware', hardware.select.value);
    });
    model.select.addEventListener('change', function () {
      onNarrow('model', model.select.value);
    });
    modelClass.select.addEventListener('change', function () {
      onNarrow('modelClass', modelClass.select.value);
    });
    round.select.addEventListener('change', function () {
      state.date = ANY;
      state.round = round.select.value;
      render();
    });
    reset.addEventListener('click', function () {
      state = { round: ANY, date: ANY, hardware: ANY, model: ANY, modelClass: ANY };
      render();
    });
    window.addEventListener('popstate', function () {
      state = readState();
      render();
    });

    root.setAttribute('data-hb-scorecard-ready', '1');
    render();
  }

  function start() {
    var roots = document.querySelectorAll('[' + ATTR.root + ']');
    for (var i = 0; i < roots.length; i++) enhance(roots[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;
