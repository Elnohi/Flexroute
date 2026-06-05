exports.handler = async function() {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    },
    body: JSON.stringify([{
      "relation": ["delegate_permission/common.handle_all_urls"],
      "target": {
        "namespace": "android_app",
        "package_name": "com.flexrouteapp.twa",
        "sha256_cert_fingerprints": [
          "1C:F5:61:41:48:73:B4:C4:6D:1F:A6:18:51:49:39:55:A3:06:BD:A4:3C:7B:5A:64:10:B0:7A:68:3A:84:19:49",
          "D0:18:01:30:D5:74:03:F3:91:0F:F3:78:AC:8F:59:D8:8F:74:BF:24:21:F2:04:92:80:A9:9E:BB:68:C4:9A:86"
        ]
      }
    }])
  };
};
