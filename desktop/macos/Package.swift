// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FilmOSDesktop",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(name: "FilmOSDesktopCore", targets: ["FilmOSDesktopCore"]),
        .executable(name: "FilmOSStudioDesktop", targets: ["FilmOSStudioDesktop"]),
    ],
    targets: [
        .target(
            name: "FilmOSDesktopCore",
            linkerSettings: [
                .linkedFramework("Security"),
            ]
        ),
        .executableTarget(
            name: "FilmOSStudioDesktop",
            dependencies: ["FilmOSDesktopCore"],
            linkerSettings: [
                .linkedFramework("WebKit"),
            ]
        ),
        .testTarget(
            name: "FilmOSDesktopCoreTests",
            dependencies: ["FilmOSDesktopCore"]
        ),
    ]
)
