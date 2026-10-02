// dist/hubspot-leads.js
var FORM_GUID = "38e62b8a-4656-47b4-a60b-d91f3be1c230";
exports.handler = async function(event) {
  var want = process.env.MANAGER_KEY || "";
  var got = event.headers && (event.headers["x-manager-key"] || event.headers["X-Manager-Key"]) || "";
  if (!want || got !== want) {
    return json(401, { error: "unauthorized", message: "A valid manager key is required." });
  }
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return json(500, { error: "not_configured", message: "HUBSPOT_TOKEN is not set on this site." });
  }
  const limit = 50;
  var qs = event.queryStringParameters || {};
  if (qs.debug === "addfield") {
    var out = {};
    try {
      var g = await fetch(
        "https://api.hubapi.com/marketing/v3/forms/" + FORM_GUID,
        { headers: { Authorization: "Bearer " + token } }
      );
      var def = await g.json();
      var groups = def.fieldGroups || [];
      var allFields = [];
      groups.forEach(function(gr) {
        (gr.fields || []).forEach(function(f) {
          allFields.push(f);
        });
      });
      if (!allFields.some(function(x) {
        return x.name === "move_size";
      })) {
        allFields.push({
          objectTypeId: "0-1",
          name: "move_size",
          label: "Move size",
          required: false,
          hidden: false,
          fieldType: "dropdown",
          options: [
            { label: "Studio", value: "studio", displayOrder: 0, hidden: false },
            { label: "1 bedroom", value: "1_bedroom", displayOrder: 1, hidden: false },
            { label: "2 bedroom", value: "2_bedroom", displayOrder: 2, hidden: false },
            { label: "3 bedroom", value: "3_bedroom", displayOrder: 3, hidden: false },
            { label: "4+ bedrooms", value: "4_plus_bedrooms", displayOrder: 4, hidden: false },
            { label: "Office / commercial", value: "office", displayOrder: 5, hidden: false }
          ]
        });
      }
      var newGroups = [];
      for (var i = 0; i < allFields.length; i += 3) {
        newGroups.push({
          groupType: "default_group",
          richTextType: "text",
          fields: allFields.slice(i, i + 3)
        });
      }
      def.fieldGroups = newGroups;
      var pr = await fetch("https://api.hubapi.com/marketing/v3/forms/" + FORM_GUID, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(def)
      });
      out.patchStatus = pr.status;
      out.patchBody = (await pr.text()).slice(0, 600);
    } catch (e) {
      out.error = String(e && e.message || e);
    }
    return json(200, out);
  }
  if (qs.debug) {
    var out = {};
    try {
      var fd = await fetch(
        "https://api.hubapi.com/marketing/v3/forms/" + FORM_GUID,
        { headers: { Authorization: "Bearer " + token } }
      );
      out.formDefStatus = fd.status;
      out.formDefBody = (await fd.text()).slice(0, 2500);
    } catch (e) {
      out.formDefError = String(e && e.message || e);
    }
    try {
      var sr = await fetch("https://api.hubapi.com/form-integrations/v1/submissions/forms/" + FORM_GUID + "?limit=5", { headers: { Authorization: "Bearer " + token } });
      out.subStatus = sr.status;
      out.subBody = (await sr.text()).slice(0, 2500);
    } catch (e) {
      out.subError = String(e && e.message || e);
    }
    return json(200, out);
  }
  const url = "https://api.hubapi.com/form-integrations/v1/submissions/forms/" + FORM_GUID + "?limit=" + limit;
  try {
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return json(res.status, { error: "hubspot_error", message: "HubSpot returned " + res.status, detail: body.slice(0, 300) });
    }
    const data = await res.json();
    const leads = (data.results || []).map(function(s) {
      var v = {};
      (s.values || []).forEach(function(f) {
        v[f.name] = f.value;
      });
      return {
        id: String(s.submittedAt || "") + "-" + (v.email || v.phone || Math.random()),
        submittedAt: s.submittedAt || null,
        firstname: v.firstname || "",
        email: v.email || "",
        phone: v.phone || "",
        moveDate: v.estimated_moving_date || "",
        moveSize: v.move_size || "",
        pickup: v.loading_address_or_zip_code_ || "",
        dropoff: v.unloading_zip_code || "",
        source: "website"
      };
    });
    var seenEmails = {};
    leads.forEach(function(l) {
      if (l.email) seenEmails[l.email.toLowerCase()] = 1;
    });
    var fb = await facebookLeads(token, seenEmails);
    var all = leads.concat(fb);
    all.sort(function(a, b) {
      return (b.submittedAt || 0) - (a.submittedAt || 0);
    });
    return json(200, { leads: all });
  } catch (e) {
    return json(500, { error: "fetch_failed", message: String(e && e.message || e) });
  }
};
async function facebookLeads(token, seenEmails) {
  var out = [];
  try {
    var since = Date.now() - 30 * 864e5;
    var res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(since) }] }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: [
          "firstname",
          "lastname",
          "email",
          "phone",
          "mobilephone",
          "city",
          "hs_analytics_source",
          "hs_analytics_source_data_1",
          "hs_analytics_source_data_2",
          "hs_latest_source",
          "createdate"
        ],
        limit: 50
      })
    });
    if (!res.ok) return out;
    var data = await res.json();
    (data.results || []).forEach(function(c) {
      var p = c.properties || {};
      var src = ((p.hs_analytics_source || "") + " " + (p.hs_analytics_source_data_1 || "") + " " + (p.hs_analytics_source_data_2 || "") + " " + (p.hs_latest_source || "")).toLowerCase();
      if (src.indexOf("facebook") < 0 && src.indexOf("meta") < 0 && src.indexOf("instagram") < 0) return;
      var email = (p.email || "").toLowerCase();
      if (!email || seenEmails[email]) return;
      seenEmails[email] = 1;
      var name = ((p.firstname || "") + " " + (p.lastname || "")).trim();
      out.push({
        id: "fb-" + c.id,
        submittedAt: Number(p.createdate) || null,
        firstname: name,
        email: p.email || "",
        phone: p.phone || p.mobilephone || "",
        moveDate: "",
        moveSize: "",
        pickup: p.city || "",
        dropoff: "",
        source: "facebook"
      });
    });
  } catch (e) {
  }
  return out;
}
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj)
  };
}
