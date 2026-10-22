const ui = require("./_adbui.js");
(async () => {
  ui.sh(["shell", "uiautomator", "dump", "/sdcard/_tv.xml"]);
  const xml = ui.sh(["shell", "cat", "/sdcard/_tv.xml"]);
  // TrackView 是自定义 View，class 名会是 com.icar.obd.ui.view.TrackView
  const re = /class="([^"]*TrackView[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m, n = 0;
  console.log("=== uiautomator 中的 TrackView 节点 ===");
  while ((m = re.exec(xml)) !== null) {
    n++;
    console.log("  [" + n + "] " + m[1] + " bounds=[" + m[2] + "," + m[3] + "][" + m[4] + "," + m[5] + "]");
  }
  console.log("  合计=" + n);
  if (!n) {
    console.log("\n  未找到，检查 canvasRoot 下的所有节点 class：");
    const re2 = /class="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    const seen = new Set();
    let k;
    while ((k = re2.exec(xml)) !== null) {
      const key = k[1] + " " + k[2] + "," + k[3];
      if (!seen.has(key)) { seen.add(key); console.log("    " + k[1] + " [" + k[2] + "," + k[3] + "][" + k[4] + "," + k[5] + "]"); }
    }
  }
})();
