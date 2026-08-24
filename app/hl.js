// Self-contained syntax highlighter. No dependencies, works offline. Scoped to the 7 languages
// the code panel offers; anything else renders unhighlighted. Emits spans with classes
// hl-kw / hl-str / hl-com / hl-doc / hl-num / hl-fn, themed in styles.css.
(function (global) {
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function span(cls, text) { return "<span class='" + cls + "'>" + esc(text) + "</span>"; }

  function kwset(words) { var o = {}; words.split(" ").forEach(function (w) { o[w] = 1; }); return o; }

  var KW = {
    python: kwset("def return if elif else for while in not and or is None True False class import from as with try except finally raise lambda yield pass break continue global nonlocal assert del async await match case"),
    javascript: kwset("function return if else for while do in of new var let const class extends super this typeof instanceof null undefined true false try catch finally throw switch case break continue default delete void yield async await import export from static get set"),
    typescript: kwset("function return if else for while do in of new var let const class extends super this typeof instanceof null undefined true false try catch finally throw switch case break continue default delete void yield async await import export from static get set interface type enum implements public private protected readonly abstract namespace declare as keyof infer never unknown any string number boolean"),
    java: kwset("public private protected static final void int long double float boolean char byte short class interface enum extends implements return if else for while do switch case break continue default new this super null true false try catch finally throw throws import package abstract synchronized volatile transient instanceof var record"),
    go: kwset("func return if else for range switch case break continue default var const type struct interface map chan go defer select package import nil true false make new len cap append copy delete panic recover error string int int64 float64 bool byte rune"),
    cpp: kwset("int long double float char bool void auto const constexpr static class struct enum union template typename namespace using return if else for while do switch case break continue default new delete this nullptr true false try catch throw public private protected virtual override friend inline operator sizeof unsigned signed size_t std string vector map set pair include define"),
    sql: kwset("select from where group by having order limit offset insert into values update set delete create table index view alter drop join inner left right full outer on as and or not null distinct union all exists in between like case when then else end count sum avg min max with recursive primary key foreign references constraint unique default check")
  };

  // Per-language comment syntax; strings and numbers are shared. Order matters: doc/comment
  // and string patterns must win before the word pattern can see their contents.
  var LINE_COMMENT = { python: /#[^\n]*/y, sql: /--[^\n]*/y,
    javascript: /\/\/[^\n]*/y, typescript: /\/\/[^\n]*/y, java: /\/\/[^\n]*/y, go: /\/\/[^\n]*/y, cpp: /\/\/[^\n]*/y };
  var TRIPLE = /("""[\s\S]*?"""|'''[\s\S]*?''')/y;                  // python docstrings
  var BLOCK = /\/\*[\s\S]*?\*\//y;                                  // C-family block comments
  var STRING = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/y;
  var NUMBER = /(0[xXbBoO][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/y;
  var WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;

  function highlight(code, lang) {
    lang = (lang || "").toLowerCase();
    if (lang === "c++") lang = "cpp";
    var kws = KW[lang];
    if (!kws) return esc(code);
    var lineC = LINE_COMMENT[lang];
    var sqlMode = lang === "sql";
    var out = [], i = 0, n = code.length;

    function tryAt(re) { re.lastIndex = i; var m = re.exec(code); return (m && m.index === i) ? m[0] : null; }

    while (i < n) {
      var m;
      if (lang === "python" && (m = tryAt(TRIPLE))) { out.push(span("hl-doc", m)); i += m.length; continue; }
      if (lineC && (m = tryAt(lineC))) { out.push(span("hl-com", m)); i += m.length; continue; }
      if (!sqlMode && lang !== "python" && (m = tryAt(BLOCK))) {
        out.push(span(m.indexOf("/**") === 0 ? "hl-doc" : "hl-com", m)); i += m.length; continue;
      }
      if ((m = tryAt(STRING))) { out.push(span("hl-str", m)); i += m.length; continue; }
      if ((m = tryAt(NUMBER))) { out.push(span("hl-num", m)); i += m.length; continue; }
      if ((m = tryAt(WORD))) {
        var key = sqlMode ? m.toLowerCase() : m;
        if (kws[key]) out.push(span("hl-kw", m));
        else {
          // function-call heuristic: identifier directly followed by "("
          var j = i + m.length;
          while (j < n && (code[j] === " " || code[j] === "\t")) j++;
          out.push(code[j] === "(" ? span("hl-fn", m) : esc(m));
        }
        i += m.length; continue;
      }
      out.push(esc(code[i])); i++;
    }
    return out.join("");
  }

  global.HL = { highlight: highlight };
})(window);
