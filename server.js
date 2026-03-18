require("dotenv").config();
const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const multer = require("multer");
const session = require("express-session");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const PDFDocument = require("pdfkit");
const store = require("./lib/store");

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  })
);

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.CALLBACK_URL
    },
    (_accessToken, _refreshToken, profile, done) => {
      if (!profile.id) return done(new Error("Google profile missing id"));
      // Store a plain object — the Profile class instance does not survive JSON session serialization
      done(null, {
        id: profile.id,
        displayName: profile.displayName || "",
        email: profile.emails && profile.emails[0] ? profile.emails[0].value : ""
      });
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// Make current user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

// Auth routes (unprotected)
app.get("/login", (req, res) => {
  if (req.isAuthenticated()) return res.redirect("/");
  res.render("login");
});

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => res.redirect("/")
);

app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect("/login");
  });
});

// Require authentication for all routes below
app.use((req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect("/login");
});

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalNumber(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw.length) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parseCsvLine(line, delimiter = ",") {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  cells.push(current.trim());
  return cells;
}

function normalizeCsvRows(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) return [];

  const delimiter = lines[0].includes("\t") && !lines[0].includes(",") ? "\t" : ",";
  // Always skip the first line (header row)
  const dataLines = lines.slice(1);

  return dataLines.map((line) => parseCsvLine(line, delimiter));
}

function normalizeCustomerCsvRows(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) return [];

  const delimiter = lines[0].includes("\t") && !lines[0].includes(",") ? "\t" : ",";
  // Always skip the first line (header row)
  const dataLines = lines.slice(1);

  return dataLines.map((line) => parseCsvLine(line, delimiter));
}

function required(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeVehicleType(value) {
  const allowedTypes = new Set([
    "Vehicle",
    "ATV",
    "SxS",
    "Tractor",
    "Lawn Mower",
    "Chainsaw",
    "Leafblower",
    "Golf Cart",
    "Other"
  ]);

  const nextType = typeof value === "string" ? value.trim() : "";
  return allowedTypes.has(nextType) ? nextType : "Vehicle";
}

function normalizeVehicleTypeOther(value, vehicleType) {
  if (vehicleType !== "Other") return "";
  const text = typeof value === "string" ? value.trim() : "";
  return text || "Other";
}

function getLastServiceDate(vehicle) {
  if (!Array.isArray(vehicle.services) || !vehicle.services.length) {
    return null;
  }

  let latest = null;
  for (const service of vehicle.services) {
    if (!service || !service.date) continue;
    if (!latest || service.date > latest) {
      latest = service.date;
    }
  }
  return latest;
}

function sortVehicles(vehicles, sortKey, sortDir) {
  const sorted = [...vehicles];

  sorted.sort((a, b) => {
    let comparison;
    switch (sortKey) {
      case "year":
        comparison = Number(a.year || 0) - Number(b.year || 0); break;
      case "make":
        comparison = (a.make || "").localeCompare(b.make || ""); break;
      case "model":
        comparison = (a.model || "").localeCompare(b.model || ""); break;
      case "plate":
        comparison = (a.plate || "").localeCompare(b.plate || ""); break;
      case "vin":
        comparison = (a.vin || "").localeCompare(b.vin || ""); break;
      case "mileage":
        comparison = Number(a.currentMileage || 0) - Number(b.currentMileage || 0); break;
      case "lastServiceDate":
      default: {
        const aTime = a.lastServiceDate ? new Date(a.lastServiceDate).getTime() : 0;
        const bTime = b.lastServiceDate ? new Date(b.lastServiceDate).getTime() : 0;
        comparison = aTime - bTime;
        break;
      }
    }
    return sortDir === "desc" ? -comparison : comparison;
  });

  return sorted;
}

function sortCustomers(customers, sortKey, sortDir) {
  const sorted = [...customers];

  sorted.sort((a, b) => {
    let comparison;
    switch (sortKey) {
      case "firstName":
        comparison = (a.firstName || "").localeCompare(b.firstName || ""); break;
      case "phone":
        comparison = (a.phone || "").localeCompare(b.phone || ""); break;
      case "email":
        comparison = (a.email || "").localeCompare(b.email || ""); break;
      case "lastName":
      default:
        comparison = (a.lastName || "").localeCompare(b.lastName || ""); break;
    }
    return sortDir === "desc" ? -comparison : comparison;
  });

  return sorted;
}

app.get("/", async (req, res) => {
  const uid = req.user.id;
  const activeTab = req.query.tab === "customers" ? "customers" : "vehicles";
  const vehicleScope = req.query.vehicleScope === "customer" ? "customer" : req.query.vehicleScope === "all" ? "all" : "my";
  const sortKey = typeof req.query.sort === "string" ? req.query.sort : "lastServiceDate";
  const defaultDir = sortKey === "lastServiceDate" ? "desc" : "asc";
  const sortDir = req.query.dir === "asc" ? "asc" : req.query.dir === "desc" ? "desc" : defaultDir;
  const vehicles = await store.getVehicles(uid);
  const customers = await store.getCustomers(uid);

  const vehiclesWithLastService = vehicles.map((vehicle) => ({
    ...vehicle,
    lastServiceDate: getLastServiceDate(vehicle)
  }));

  const filteredVehicles = vehiclesWithLastService.filter((vehicle) => {
    if (vehicleScope === "all") return true;
    if (vehicleScope === "customer") return !vehicle.isMyVehicle;
    return vehicle.isMyVehicle;
  });

  const sortedVehicles = sortVehicles(filteredVehicles, sortKey, sortDir);
  const sortedCustomers = sortCustomers(customers, sortKey, sortDir);

  res.render("index", {
    vehicles: sortedVehicles,
    customers: sortedCustomers,
    activeTab,
    vehicleScope,
    sortKey,
    sortDir
  });
});

app.get("/vehicles/new", async (req, res) => {
  const customers = await store.getCustomers(req.user.id);
  res.render("vehicle-new", { customers });
});

app.get("/vehicles/import-csv", (req, res) => {
  res.render("vehicle-import-csv", { imported: 0, error: "" });
});

app.post("/vehicles/import-csv", upload.single("csvFile"), async (req, res) => {
  const uploadedText = req.file ? req.file.buffer.toString("utf8") : "";
  const fallbackText = req.body && typeof req.body.csvText === "string" ? req.body.csvText : "";
  const rows = normalizeCsvRows(uploadedText || fallbackText);

  if (!rows.length) {
    return res.status(400).render("vehicle-import-csv", {
      imported: 0,
      error: "CSV file is empty or invalid. Use columns: Year,Make,Model,Plate,Vin,Mileage,Hours"
    });
  }

  let imported = 0;

  for (const row of rows) {
    const [year, make, model, plate, vin, mileage, hours] = row;

    if (!required(year) || !required(make) || !required(model)) {
      continue;
    }

    const vehicleType = "Vehicle";
    const vehicle = {
      id: randomUUID(),
      userId: req.user.id,
      isMyVehicle: true,
      vehicleType,
      vehicleTypeOther: "",
      year: year.trim(),
      make: make.trim(),
      model: model.trim(),
      plate: (plate || "").trim(),
      vin: (vin || "").trim(),
      currentMileage: toNumber(mileage, 0),
      currentHours: toNumber(hours, 0),
      customerId: "",
      nickname: "",
      services: [],
      parts: [],
      scheduledMaintenance: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await store.addVehicle(vehicle);
    imported += 1;
  }

  res.render("vehicle-import-csv", { imported, error: "" });
});

app.post("/vehicles", async (req, res) => {
  const { make, model, year, plate, vin, currentMileage, nickname, customerId, isMyVehicle, vehicleType, vehicleTypeOther } = req.body;
  const { currentHours } = req.body;

  if (!required(make) || !required(model) || !required(year)) {
    return res.status(400).send("Make, model, and year are required.");
  }

  const nextVehicleType = normalizeVehicleType(vehicleType);
  const vehicle = {
    id: randomUUID(),
    userId: req.user.id,
    isMyVehicle: toBoolean(isMyVehicle, true),
    vehicleType: nextVehicleType,
    vehicleTypeOther: normalizeVehicleTypeOther(vehicleTypeOther, nextVehicleType),
    make: make.trim(),
    model: model.trim(),
    year: year.trim(),
    plate: (plate || "").trim(),
    vin: (vin || "").trim(),
    currentMileage: toNumber(currentMileage, 0),
    currentHours: toNumber(currentHours, 0),
    customerId: (customerId || "").trim(),
    nickname: (nickname || "").trim(),
    services: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await store.addVehicle(vehicle);
  res.redirect(`/vehicles/${vehicle.id}`);
});

app.get("/vehicles/:id", async (req, res) => {
  if (req.params.id === "import-csv") {
    return res.redirect("/vehicles/import-csv");
  }

  const vehicle = await store.getVehicleById(req.params.id, req.user.id);
  const customers = await store.getCustomers(req.user.id);
  if (!vehicle) {
    return res.status(404).send("Vehicle not found.");
  }
  const dueServices = store.calculateDueServices(vehicle);
  res.render("vehicle-detail", { vehicle, customers, dueServices });
});

app.post("/vehicles/:id/update", async (req, res) => {
  const { make, model, year, plate, vin, currentMileage, nickname, customerId, isMyVehicle, vehicleType, vehicleTypeOther } = req.body;
  const { currentHours } = req.body;

  if (!required(make) || !required(model) || !required(year)) {
    return res.status(400).send("Make, model, and year are required.");
  }

  const existingVehicle = await store.getVehicleById(req.params.id, req.user.id);
  if (!existingVehicle) {
    return res.status(404).send("Vehicle not found.");
  }

  const hasVehicleType = typeof vehicleType === "string" && vehicleType.trim().length > 0;
  const nextVehicleType = hasVehicleType
    ? normalizeVehicleType(vehicleType)
    : (existingVehicle.vehicleType || "Vehicle");
  const nextVehicleTypeOther = hasVehicleType
    ? normalizeVehicleTypeOther(vehicleTypeOther, nextVehicleType)
    : (existingVehicle.vehicleTypeOther || "");

  const updated = await store.updateVehicle(req.params.id, {
    make: make.trim(),
    model: model.trim(),
    year: year.trim(),
    isMyVehicle: toBoolean(isMyVehicle, true),
    vehicleType: nextVehicleType,
    vehicleTypeOther: nextVehicleTypeOther,
    plate: (plate || "").trim(),
    vin: (vin || "").trim(),
    currentMileage: toNumber(currentMileage, 0),
    currentHours: toNumber(currentHours, 0),
    customerId: (customerId || "").trim(),
    nickname: (nickname || "").trim()
  }, req.user.id);

  if (!updated) {
    return res.status(404).send("Vehicle not found.");
  }

  res.redirect(`/vehicles/${req.params.id}`);
});

app.post("/vehicles/:id/delete", async (req, res) => {
  await store.deleteVehicle(req.params.id, req.user.id);
  res.redirect("/");
});

app.post("/vehicles/:id/services", async (req, res) => {
  const vehicle = await store.getVehicleById(req.params.id, req.user.id);
  if (!vehicle) {
    return res.status(404).send("Vehicle not found.");
  }

  const { date, serviceType, serviceCategory, description, mileage, hours, cost, notes } = req.body;

  if (!required(date) || !required(serviceType)) {
    return res.status(400).send("Service date and type are required.");
  }

  await store.addServiceRecord(req.params.id, {
    id: randomUUID(),
    date: date.trim(),
    serviceType: serviceType.trim(),
    serviceCategory: (serviceCategory || "Generic Service").trim(),
    description: (description || "").trim(),
    mileage: toOptionalNumber(mileage),
    hours: toOptionalNumber(hours),
    cost: toNumber(cost, 0),
    notes: (notes || "").trim(),
    createdAt: new Date().toISOString()
  }, req.user.id);

  res.redirect(`/vehicles/${req.params.id}`);
});

app.post("/vehicles/:id/services/:recordId/delete", async (req, res) => {
  await store.deleteServiceRecord(req.params.id, req.params.recordId, req.user.id);
  res.redirect(`/vehicles/${req.params.id}`);
});

app.post("/vehicles/:id/parts", async (req, res) => {
  const vehicle = await store.getVehicleById(req.params.id, req.user.id);
  if (!vehicle) {
    return res.status(404).send("Vehicle not found.");
  }

  const { partName, partNumber, notes } = req.body;

  if (!required(partName)) {
    return res.status(400).send("Part name is required.");
  }

  await store.addPart(req.params.id, {
    id: randomUUID(),
    partName: partName.trim(),
    partNumber: (partNumber || "").trim(),
    notes: (notes || "").trim(),
    createdAt: new Date().toISOString()
  }, req.user.id);

  res.redirect(`/vehicles/${req.params.id}`);
});

app.post("/vehicles/:id/parts/:partId/delete", async (req, res) => {
  await store.deletePart(req.params.id, req.params.partId, req.user.id);
  res.redirect(`/vehicles/${req.params.id}`);
});

app.get("/customers/new", (req, res) => {
  res.render("customer-new");
});

app.post("/customers", async (req, res) => {
  const { firstName, lastName, phone, email } = req.body;

  if (!required(firstName) || !required(lastName)) {
    return res.status(400).send("First name and last name are required.");
  }

  const customer = {
    id: randomUUID(),
    userId: req.user.id,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    phone: (phone || "").trim(),
    email: (email || "").trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await store.addCustomer(customer);
  res.redirect(`/customers/${customer.id}`);
});

app.get("/customers/import-csv", (req, res) => {
  res.render("customer-import-csv", { imported: 0, error: "" });
});

app.post("/customers/import-csv", upload.single("csvFile"), async (req, res) => {
  const uploadedText = req.file ? req.file.buffer.toString("utf8") : "";
  const rows = normalizeCustomerCsvRows(uploadedText);

  if (!rows.length) {
    return res.status(400).render("customer-import-csv", {
      imported: 0,
      error: "CSV file is empty or invalid. Use columns: FirstName,LastName,Phone,Email"
    });
  }

  let imported = 0;

  for (const row of rows) {
    const [firstName, lastName, phone, email] = row;

    if (!required(firstName) || !required(lastName)) {
      continue;
    }

    const customer = {
      id: randomUUID(),
      userId: req.user.id,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: (phone || "").trim(),
      email: (email || "").trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await store.addCustomer(customer);
    imported += 1;
  }

  res.render("customer-import-csv", { imported, error: "" });
});

app.get("/customers/:id", async (req, res) => {
  if (req.params.id === "import-csv") {
    return res.redirect("/customers/import-csv");
  }

  const customer = await store.getCustomerById(req.params.id, req.user.id);
  if (!customer) {
    return res.status(404).send("Customer not found.");
  }

  const vehicles = await store.getVehiclesByCustomer(req.params.id, req.user.id);
  res.render("customer-detail", { customer, vehicles });
});

app.get("/customers/:id/edit", async (req, res) => {
  const customer = await store.getCustomerById(req.params.id, req.user.id);
  if (!customer) {
    return res.status(404).send("Customer not found.");
  }
  res.render("customer-edit", { customer });
});

app.post("/customers/:id/update", async (req, res) => {
  const { firstName, lastName, phone, email } = req.body;

  if (!required(firstName) || !required(lastName)) {
    return res.status(400).send("First name and last name are required.");
  }

  const updated = await store.updateCustomer(req.params.id, {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    phone: (phone || "").trim(),
    email: (email || "").trim()
  }, req.user.id);

  if (!updated) {
    return res.status(404).send("Customer not found.");
  }

  res.redirect(`/customers/${req.params.id}`);
});

app.post("/customers/:id/delete", async (req, res) => {
  await store.deleteCustomer(req.params.id, req.user.id);
  res.redirect("/?tab=customers");
});

app.post("/vehicles/:id/scheduled-maintenance", async (req, res) => {
  const vehicle = await store.getVehicleById(req.params.id, req.user.id);
  if (!vehicle) {
    return res.status(404).send("Vehicle not found.");
  }

  const { type, interval, part, notes } = req.body;

  if (!required(type) || !required(interval)) {
    return res.status(400).send("Service type and interval are required.");
  }

  await store.addScheduledMaintenance(req.params.id, {
    id: randomUUID(),
    type: type.trim(),
    interval: toNumber(interval, 0),
    part: (part || "").trim(),
    notes: (notes || "").trim(),
    createdAt: new Date().toISOString()
  }, req.user.id);

  res.redirect(`/vehicles/${req.params.id}`);
});

app.post("/vehicles/:id/scheduled-maintenance/:maintenanceId/delete", async (req, res) => {
  await store.deleteScheduledMaintenance(req.params.id, req.params.maintenanceId, req.user.id);
  res.redirect(`/vehicles/${req.params.id}`);
});

app.get("/vehicles/:id/report", async (req, res) => {
  const vehicle = await store.getVehicleById(req.params.id, req.user.id);
  if (!vehicle) return res.status(404).send("Vehicle not found.");

  const customers = await store.getCustomers(req.user.id);
  const customer = customers.find((c) => c.id === vehicle.customerId) || null;

  const services = Array.isArray(vehicle.services) ? [...vehicle.services] : [];
  services.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const totalCost = services.reduce((sum, s) => sum + toNumber(s.cost, 0), 0);

  const servicesWithMileage = services.filter((s) => Number.isFinite(s.mileage));
  let milesDriven = null;
  if (servicesWithMileage.length >= 2) {
    const first = servicesWithMileage[0].mileage;
    const last = servicesWithMileage[servicesWithMileage.length - 1].mileage;
    milesDriven = last - first;
  }

  const vehicleLabel = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.nickname ? ` — ${vehicle.nickname}` : ""}`;
  const reportDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const doc = new PDFDocument({ margin: 50, size: "LETTER" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="service-report-${vehicle.id}.pdf"`);
  doc.pipe(res);

  // ── Header bar ────────────────────────────────────────────────────────────
  doc.rect(50, 40, doc.page.width - 100, 70).fill("#1a1a2e");
  doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold")
    .text("DrivewayDoc", 70, 55, { width: doc.page.width - 140, align: "left" });
  doc.fillColor("#aaaacc").fontSize(10).font("Helvetica")
    .text("Vehicle Service Report", 70, 82, { width: doc.page.width - 140, align: "left" });
  doc.fillColor("#aaaacc").fontSize(10)
    .text(reportDate, 70, 82, { width: doc.page.width - 140, align: "right" });

  doc.moveDown(3);

  // ── Vehicle Title ─────────────────────────────────────────────────────────
  doc.fillColor("#1a1a2e").fontSize(18).font("Helvetica-Bold")
    .text(vehicleLabel, 50, 130);
  doc.moveTo(50, 152).lineTo(doc.page.width - 50, 152).strokeColor("#ddddee").lineWidth(1).stroke();

  // ── Vehicle Info grid ─────────────────────────────────────────────────────
  doc.y = 162;
  const infoItems = [
    ["Vehicle Type", vehicle.vehicleType === "Other" ? (vehicle.vehicleTypeOther || "Other") : (vehicle.vehicleType || "Vehicle")],
    ["Year", vehicle.year || "-"],
    ["Make", vehicle.make || "-"],
    ["Model", vehicle.model || "-"],
    ["Plate", vehicle.plate || "-"],
    ["VIN", vehicle.vin || "-"],
    ["Current Mileage", `${Number(vehicle.currentMileage || 0).toLocaleString()} mi`],
    ["Current Hours", `${Number(vehicle.currentHours || 0).toLocaleString()} hrs`],
    ["Owner", vehicle.isMyVehicle ? "My Vehicle" : "Customer Vehicle"],
  ];
  if (!vehicle.isMyVehicle && customer) {
    infoItems.push(["Customer", `${customer.firstName} ${customer.lastName}`]);
  }

  const colW = (doc.page.width - 100) / 2;
  let col = 0;
  let rowY = doc.y;
  for (const [label, value] of infoItems) {
    const x = 50 + col * colW;
    doc.fillColor("#888899").fontSize(8).font("Helvetica").text(label.toUpperCase(), x, rowY);
    doc.fillColor("#1a1a2e").fontSize(10).font("Helvetica-Bold").text(value, x, rowY + 11);
    col += 1;
    if (col > 1) { col = 0; rowY += 34; }
  }
  if (col !== 0) rowY += 34;

  doc.y = rowY + 10;

  // ── Summary box ───────────────────────────────────────────────────────────
  const summaryY = doc.y + 4;
  doc.rect(50, summaryY, doc.page.width - 100, 54).fill("#f0f0f8");
  doc.fillColor("#555566").fontSize(8).font("Helvetica").text("TOTAL SPENT", 70, summaryY + 8);
  doc.fillColor("#1a1a2e").fontSize(16).font("Helvetica-Bold")
    .text(`$${totalCost.toFixed(2)}`, 70, summaryY + 20);

  const midX = 50 + (doc.page.width - 100) / 2;
  doc.fillColor("#555566").fontSize(8).font("Helvetica").text("MILES DRIVEN (FIRST → LAST SERVICE)", midX, summaryY + 8);
  doc.fillColor("#1a1a2e").fontSize(16).font("Helvetica-Bold")
    .text(milesDriven !== null ? `${Number(milesDriven).toLocaleString()} mi` : "N/A", midX, summaryY + 20);

  doc.y = summaryY + 64;

  // ── Service Records table ─────────────────────────────────────────────────
  doc.fillColor("#1a1a2e").fontSize(13).font("Helvetica-Bold").text("Service Records", 50, doc.y + 6);
  doc.y += 24;
  doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor("#ddddee").lineWidth(1).stroke();
  doc.y += 6;

  if (!services.length) {
    doc.fillColor("#888899").fontSize(10).font("Helvetica").text("No service records on file.", 50, doc.y + 4);
  } else {
    const colWidths = [70, 120, 140, 80, 55, 80];
    const headers = ["Date", "Type", "Description", "Mileage / Hrs", "Cost", "Category"];
    const tableX = 50;

    // Header row
    doc.rect(tableX, doc.y, doc.page.width - 100, 18).fill("#1a1a2e");
    let cx = tableX + 6;
    const headerY = doc.y;
    for (let i = 0; i < headers.length; i++) {
      doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold")
        .text(headers[i], cx, headerY + 5, { width: colWidths[i] - 4, ellipsis: true });
      cx += colWidths[i];
    }
    doc.y = headerY + 18;

    let rowIndex = 0;
    for (const record of services) {
      const rowHeight = 20;

      // Page break check
      if (doc.y + rowHeight > doc.page.height - 60) {
        doc.addPage();
        doc.y = 50;
        // Repeat header
        doc.rect(tableX, doc.y, doc.page.width - 100, 18).fill("#1a1a2e");
        cx = tableX + 6;
        const repeatHeaderY = doc.y;
        for (let i = 0; i < headers.length; i++) {
          doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold")
            .text(headers[i], cx, repeatHeaderY + 5, { width: colWidths[i] - 4, ellipsis: true });
          cx += colWidths[i];
        }
        doc.y = repeatHeaderY + 18;
        rowIndex = 0;
      }

      const rowBg = rowIndex % 2 === 0 ? "#ffffff" : "#f5f5fb";
      doc.rect(tableX, doc.y, doc.page.width - 100, rowHeight).fill(rowBg);

      const hasMileage = Number.isFinite(record.mileage);
      const hasHours = Number.isFinite(record.hours);
      let milesCell = "-";
      if (hasMileage && hasHours) milesCell = `${Number(record.mileage).toLocaleString()} mi / ${Number(record.hours).toLocaleString()} hr`;
      else if (hasMileage) milesCell = `${Number(record.mileage).toLocaleString()} mi`;
      else if (hasHours) milesCell = `${Number(record.hours).toLocaleString()} hr`;

      const cells = [
        record.date || "-",
        record.serviceType || "-",
        record.description || "-",
        milesCell,
        `$${Number(record.cost || 0).toFixed(2)}`,
        record.serviceCategory || "Generic Service"
      ];

      const cellY = doc.y;
      cx = tableX + 6;
      for (let i = 0; i < cells.length; i++) {
        doc.fillColor("#1a1a2e").fontSize(8).font("Helvetica")
          .text(cells[i], cx, cellY + 6, { width: colWidths[i] - 4, ellipsis: true });
        cx += colWidths[i];
      }

      doc.y = cellY + rowHeight;
      rowIndex += 1;
    }

    // Total row
    const totalRowY = doc.y;
    doc.rect(tableX, totalRowY, doc.page.width - 100, 20).fill("#e8e8f4");
    const totalX = tableX + 6 + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3];
    doc.fillColor("#1a1a2e").fontSize(9).font("Helvetica-Bold")
      .text("TOTAL", tableX + 6, totalRowY + 6, { width: colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] - 4 });
    doc.fillColor("#1a1a2e").fontSize(9).font("Helvetica-Bold")
      .text(`$${totalCost.toFixed(2)}`, totalX, totalRowY + 6, { width: colWidths[4] - 4 });
    doc.y = totalRowY + 20;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerY = doc.page.height - 40;
  doc.moveTo(50, footerY - 8).lineTo(doc.page.width - 50, footerY - 8).strokeColor("#ddddee").lineWidth(0.5).stroke();
  doc.fillColor("#aaaaaa").fontSize(8).font("Helvetica")
    .text(`Generated by DrivewayDoc  •  ${reportDate}`, 50, footerY, { width: doc.page.width - 100, align: "center" });

  doc.end();
});

app.listen(port, () => {
  console.log(`DrivewayDoc running at http://localhost:${port}`);
});
