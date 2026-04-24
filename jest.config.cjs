module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/dist/tests"],
  testMatch: ["**/*.test.js"],
  collectCoverageFrom: ["dist/src/**/*.js"],
};
