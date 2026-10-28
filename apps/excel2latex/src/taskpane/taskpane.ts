/*
 * Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
 * See LICENSE in the project root for license information.
 */

/* global console, document, Excel, Office, MathJax, OfficeExtension, window*/

Office.onReady(info => {
  if (info.host === Office.HostType.Excel) {
    document.getElementById("sideload-msg").style.display = "none";
    document.getElementById("app-body").style.display = "flex";
    document.getElementById("copy").onclick = copy;

    // Rerender LaTeX preview on content change
    const node = document.getElementById("preview");
    const observer = new window.MutationObserver(() => {
      MathJax.Hub.Queue(["Typeset",MathJax.Hub,"preview"]);
      // use MathJax.typesetPromise() with MathJax v2 when @types/mathjax gets updated
    });
    observer.observe(node, {
        attributes: true,
        childList: true,
        subtree: true
    });

    Excel.run(async context => {
      // hot reload
      const range = context.workbook.getSelectedRange();
      await context.sync()
      const binding = context.workbook.bindings.add(range, "Range", "HotReload");
      binding.onDataChanged.add(run);
      await context.sync();
      
      // initial load
      run({ binding });
      await context.sync();
    }).catch(excelError);
  }
});

function copy() {
  const tex = document.getElementById("preview").querySelector("script[type*='math/tex']").innerHTML;
  navigator.clipboard.writeText(tex);
}

export async function run(event: Excel.BindingDataChangedEventArgs) {
  Excel.run(async context => {
    const range = event.binding.getRange();
    range.load('values'); 

    const props = range.getCellProperties({
      format: {
        font: {
          bold: true,
          color: true,
          italic: true,
          strikethrough: true,
          subscript: true,
          superscript: true,
          underline: true
        },
        // borders: {
        //   style: true
        // },
        // fill: {
        //   color: true
        // },
        // horizontalAlignment: true
      }
    });

    await context.sync(); // first-time context
    await event.binding.context.sync(); // hot-reload context

    document.getElementById("preview").innerText = rangeToLatex(range, props);
  }).catch(excelError);
}

function excelError(error) {
  if (error instanceof OfficeExtension.Error) {
    switch (error.code) {
      case "InvalidSelection": displayError("Please select a single range."); break;
      default: displayError(error.message);
    }
  } else {
    displayError(error);
  }
}

function displayError(message) {
  document.getElementById("app-body").style.display = "none";
  document.getElementById("error-body").removeAttribute("style");
  document.getElementById("error-msg").innerHTML = message;
  console.error(message);
}

function rangeToLatex(range: Excel.Range, props: OfficeExtension.ClientResult<Excel.CellProperties[][]>) {
  // Convert single-row ranges (1D array) to standard 2D
  if (typeof range.values[0] === 'string') {
    range.values = [range.values];
  }

  let packages = {};
  const rows = range.values.map((row, i) => {
    return row.map((value, j) => {
      if (value === '') return '';
      value = value.toString(); // values can be strings, numbers or bools

      const formatted = applyFormat(i, j, value, props.value[i][j].format, packages);
      packages = formatted.packages;
      return formatted.value;
    }).join(' & ') + '\\\\';
  });

  return [
    ...Object.values(packages),
    `\\begin{array}{${"c".repeat(range.values[0].length)}}`,
    ...rows,
    "\\end{array}"
  ].join('\n');
}

// Only applies if format applied to entire cell, not individual letters
// TODO non-MathJax preview rendering to support border/fill/alignment
function applyFormat(i: number, j:number, value: string, format: Excel.CellPropertiesFormat, packages) {
  if (format.font.bold) value = `\\textbf{${value}}`

  if (format.font.color !== "#000000") {
    if (!packages.color) packages.color = "\\usepackage{xcolor}";
    value = `\\textcolor{${format.font.color}}{${value}}`;
  }

  if (format.font.italic) value = `\\textit{${value}}`

  // TODO apply font and fontsize

  if (format.font.strikethrough) {
    if (!packages.strikethrough) packages.strikethrough = "\\usepackage{cancel}";
    value = `\\cancel{${value}}`;
  }

  if (format.font.subscript) {
    if (!packages.subscript) packages.subscript = "\\usepackage{fixltx2e}";
    value = `\\textsubscript{${value}}`;
  }

  if (format.font.superscript) value = `\\textsuperscript{${value}}`

  if (format.font.underline === "Single") value = `\\underline{${value}}`

  // \multicolumn isn't supported by MathJax
  // const leftBorder = format.borders.left.style !== "None";
  // const rightBorder = format.borders.right.style !== "None";
  // if (leftBorder || rightBorder) {
  //   value = `\\multicolumn{1}{${leftBorder ? "|" : ''}${value}${rightBorder ? "|" : ''}}`;
  // }
  
  // \cline isn't supported by MathJax
  // if (i === 0 && format.borders.top.style !== "None") value = `\\cline{${j}-${j}}${value}`;
  // if (format.borders.bottom.style !== "None") value += `\\cline{${j}-${j}}`;

  // \cellcolor isn't supported by MathJax
  // if (format.fill.color !== "#000000") value = `\\cellcolor{${format.fill.color}}${value}`;

  // \multicolumn isn't supported by MathJax
  // switch (format.horizontalAlignment) {
  //   case "Left": `\\multicolumn{1}{l}{${value}}`; break;
  //   case "Center": `\\multicolumn{1}{c}{${value}}`; break;
  //   case "Right": `\\multicolumn{1}{r}{${value}}`; break;
  // }

  // TODO cell width - not available directly on cell

  return { value, packages };
}