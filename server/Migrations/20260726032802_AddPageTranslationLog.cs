using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebOcrServer.Migrations
{
    /// <inheritdoc />
    public partial class AddPageTranslationLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "PageTranslationLogs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    JobId = table.Column<string>(type: "TEXT", nullable: false),
                    BubbleIndex = table.Column<int>(type: "INTEGER", nullable: false),
                    BubbleX = table.Column<float>(type: "REAL", nullable: false),
                    BubbleY = table.Column<float>(type: "REAL", nullable: false),
                    BubbleW = table.Column<float>(type: "REAL", nullable: false),
                    BubbleH = table.Column<float>(type: "REAL", nullable: false),
                    Confidence = table.Column<float>(type: "REAL", nullable: false),
                    SourceText = table.Column<string>(type: "TEXT", nullable: false),
                    TranslatedText = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PageTranslationLogs", x => x.Id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PageTranslationLogs");
        }
    }
}
