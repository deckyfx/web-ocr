using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebOcrServer.Migrations
{
    /// <inheritdoc />
    public partial class AddPortalSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsExcluded",
                table: "PageTranslationLogs",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "IsManuallyAdded",
                table: "PageTranslationLogs",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTime>(
                name: "LastEditedAt",
                table: "PageTranslationLogs",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "Volumes",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Title = table.Column<string>(type: "TEXT", nullable: false),
                    Synopsis = table.Column<string>(type: "TEXT", nullable: true),
                    CoverImagePath = table.Column<string>(type: "TEXT", nullable: true),
                    SortOrder = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Volumes", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Chapters",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    VolumeId = table.Column<int>(type: "INTEGER", nullable: true),
                    Title = table.Column<string>(type: "TEXT", nullable: false),
                    ChapterNumber = table.Column<string>(type: "TEXT", nullable: false),
                    SortOrder = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Chapters", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Chapters_Volumes_VolumeId",
                        column: x => x.VolumeId,
                        principalTable: "Volumes",
                        principalColumn: "Id");
                });

            migrationBuilder.CreateTable(
                name: "PageTranslationJobs",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    Title = table.Column<string>(type: "TEXT", nullable: false),
                    Status = table.Column<string>(type: "TEXT", nullable: false),
                    OriginalImagePath = table.Column<string>(type: "TEXT", nullable: false),
                    ResultImagePath = table.Column<string>(type: "TEXT", nullable: true),
                    OriginalWidth = table.Column<int>(type: "INTEGER", nullable: false),
                    OriginalHeight = table.Column<int>(type: "INTEGER", nullable: false),
                    BubbleCount = table.Column<int>(type: "INTEGER", nullable: false),
                    ChapterId = table.Column<int>(type: "INTEGER", nullable: true),
                    PageOrder = table.Column<int>(type: "INTEGER", nullable: false),
                    ErrorMessage = table.Column<string>(type: "TEXT", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    CompletedAt = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PageTranslationJobs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PageTranslationJobs_Chapters_ChapterId",
                        column: x => x.ChapterId,
                        principalTable: "Chapters",
                        principalColumn: "Id");
                });

            migrationBuilder.CreateIndex(
                name: "IX_Chapters_VolumeId",
                table: "Chapters",
                column: "VolumeId");

            migrationBuilder.CreateIndex(
                name: "IX_PageTranslationJobs_ChapterId",
                table: "PageTranslationJobs",
                column: "ChapterId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PageTranslationJobs");

            migrationBuilder.DropTable(
                name: "Chapters");

            migrationBuilder.DropTable(
                name: "Volumes");

            migrationBuilder.DropColumn(
                name: "IsExcluded",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "IsManuallyAdded",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "LastEditedAt",
                table: "PageTranslationLogs");
        }
    }
}
