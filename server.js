require("dotenv").config();
const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const multer = require("multer");
const session = require("express-session");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
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

    const vehicle = {
      id: randomUUID(),
      userId: req.user.id,
      isMyVehicle: true,
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
  const { make, model, year, plate, vin, currentMileage, nickname, customerId, isMyVehicle } = req.body;
  const { currentHours } = req.body;

  if (!required(make) || !required(model) || !required(year)) {
    return res.status(400).send("Make, model, and year are required.");
  }

  const vehicle = {
    id: randomUUID(),
    userId: req.user.id,
    isMyVehicle: toBoolean(isMyVehicle, true),
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
  const { make, model, year, plate, vin, currentMileage, nickname, customerId, isMyVehicle } = req.body;
  const { currentHours } = req.body;

  if (!required(make) || !required(model) || !required(year)) {
    return res.status(400).send("Make, model, and year are required.");
  }

  const updated = await store.updateVehicle(req.params.id, {
    make: make.trim(),
    model: model.trim(),
    year: year.trim(),
    isMyVehicle: toBoolean(isMyVehicle, true),
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

  const { date, serviceType, description, mileage, hours, cost, notes } = req.body;

  if (!required(date) || !required(serviceType)) {
    return res.status(400).send("Service date and type are required.");
  }

  await store.addServiceRecord(req.params.id, {
    id: randomUUID(),
    date: date.trim(),
    serviceType: serviceType.trim(),
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

app.listen(port, () => {
  console.log(`DrivewayDoc running at http://localhost:${port}`);
});
